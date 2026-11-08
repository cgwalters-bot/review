//! review-service: builds the control plane's state from GitHub queries on
//! a timer and serves it, read-only, with the app. See service/README.md.

mod github;
mod server;
mod state;
mod token;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use anyhow::{Context, Result, bail};
use tokio::signal::unix::{SignalKind, signal};
use tokio::sync::watch;

use crate::github::Client;
use crate::state::State;
use crate::token::{OctoSts, TokenSource};

const USAGE: &str = "Usage: review-service [OPTION...]

Build the control plane's state from GitHub queries every --interval
seconds and serve it read-only: /api/state, /api/repos/OWNER/REPO,
/api/events (server-sent events) and /healthz, with the built app at /.

  --listen ADDR            where to listen (default 0.0.0.0:8080)
  --allow-host NAME        a host name requests may use besides localhost
                           and IP addresses, such as the proxy's; repeatable
  --static DIR             the built app to serve (default dist)
  --interval SECONDS       refresh period, 30 to 3600 (default 60)

The GitHub token, which needs only read access, comes from one of:

  --github-token-file PATH  a file holding it, reread for every request
                            (default $GITHUB_TOKEN_FILE)
  --octo-sts-scope OWNER[/REPO] --octo-sts-identity NAME
  --octo-sts-token-file PATH
                            an Octo STS exchange of the service-account
                            token in PATH (audience octo-sts.dev) for an
                            installation token, under trust policy NAME
  (none of these)           `gh auth token`, for local runs
";

const DEFAULT_LISTEN: &str = "0.0.0.0:8080";

const DEFAULT_STATIC: &str = "dist";

const TOKEN_FILE_ENV: &str = "GITHUB_TOKEN_FILE";

/// Each refresh makes three searches, and search allows 30 a minute.
const INTERVAL_SECS: std::ops::RangeInclusive<u64> = 30..=3600;

const DEFAULT_INTERVAL_SECS: u64 = 60;

#[derive(Debug, PartialEq)]
enum TokenConfig {
    Gh,
    File(PathBuf),
    OctoSts {
        scope: String,
        identity: String,
        token_file: PathBuf,
    },
}

struct Args {
    listen: SocketAddr,
    allowed_hosts: Vec<String>,
    static_dir: PathBuf,
    interval: Duration,
    token: TokenConfig,
}

/// The arguments, with `token_file_env` the value of $GITHUB_TOKEN_FILE.
fn parse_args(
    mut args: impl Iterator<Item = String>,
    token_file_env: Option<String>,
) -> Result<Option<Args>> {
    let mut listen = DEFAULT_LISTEN.to_owned();
    let mut allowed_hosts = Vec::new();
    let mut static_dir = PathBuf::from(DEFAULT_STATIC);
    let mut interval = DEFAULT_INTERVAL_SECS;
    let mut token_file = token_file_env.filter(|f| !f.is_empty());
    let (mut sts_scope, mut sts_identity, mut sts_token_file) = (None, None, None);
    while let Some(a) = args.next() {
        let (flag, inline) = match a.split_once('=') {
            Some((f, v)) if f.starts_with("--") => (f.to_owned(), Some(v.to_owned())),
            _ => (a.clone(), None),
        };
        if flag == "-h" || flag == "--help" {
            return Ok(None);
        }
        let Some(value) = inline.or_else(|| args.next()) else {
            bail!("{flag} needs a value");
        };
        match flag.as_str() {
            "--listen" => listen = value,
            "--allow-host" => allowed_hosts.push(value),
            "--static" => static_dir = value.into(),
            "--interval" => {
                interval = value
                    .parse()
                    .with_context(|| format!("--interval {value:?} is not a number of seconds"))?
            }
            "--github-token-file" => token_file = Some(value),
            "--octo-sts-scope" => sts_scope = Some(value),
            "--octo-sts-identity" => sts_identity = Some(value),
            "--octo-sts-token-file" => sts_token_file = Some(value),
            _ => bail!("unknown option {flag:?}"),
        }
    }
    if !INTERVAL_SECS.contains(&interval) {
        bail!(
            "--interval must be {} to {} seconds",
            INTERVAL_SECS.start(),
            INTERVAL_SECS.end()
        );
    }
    let listen = listen
        .parse()
        .with_context(|| format!("--listen {listen:?} is not an address and port"))?;
    let token = match (sts_scope, sts_identity, sts_token_file) {
        (None, None, None) => match token_file {
            Some(f) => TokenConfig::File(f.into()),
            None => TokenConfig::Gh,
        },
        (Some(scope), Some(identity), Some(file)) => {
            if token_file.is_some() {
                bail!("give either a token file or Octo STS, not both");
            }
            TokenConfig::OctoSts {
                scope,
                identity,
                token_file: file.into(),
            }
        }
        _ => bail!(
            "Octo STS needs all of --octo-sts-scope, --octo-sts-identity and --octo-sts-token-file"
        ),
    };
    Ok(Some(Args {
        listen,
        allowed_hosts,
        static_dir,
        interval: Duration::from_secs(interval),
        token,
    }))
}

fn token_source(config: TokenConfig) -> Result<TokenSource> {
    Ok(match config {
        TokenConfig::Gh => TokenSource::gh()?,
        TokenConfig::File(path) => TokenSource::File(path),
        TokenConfig::OctoSts {
            scope,
            identity,
            token_file,
        } => TokenSource::OctoSts(OctoSts::new(
            token::OCTO_STS_ROOT,
            scope,
            identity,
            token_file,
        )?),
    })
}

fn now() -> String {
    humantime::format_rfc3339_seconds(SystemTime::now()).to_string()
}

/// Refresh the state every `interval`, publishing each result.
async fn refresher(client: Client, tx: watch::Sender<Arc<State>>, interval: Duration) {
    let mut ticks = tokio::time::interval(interval);
    ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        ticks.tick().await;
        let prev = tx.borrow().clone();
        let next = state::refresh(&client, &prev, &now()).await;
        client.sweep();
        for (name, error) in [
            ("runs", &next.runs.error),
            ("prs", &next.prs.error),
            ("waiting", &next.waiting.error),
        ] {
            if let Some(e) = error {
                println!("review-service: {name}: {e}");
            }
        }
        tx.send_replace(Arc::new(next));
    }
}

/// SIGTERM, as Kubernetes sends, or ^C.
async fn terminated() -> Result<()> {
    let mut term = signal(SignalKind::terminate()).context("handling SIGTERM")?;
    tokio::select! {
        _ = term.recv() => {}
        r = tokio::signal::ctrl_c() => r.context("handling ^C")?,
    }
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    let Some(args) = parse_args(std::env::args().skip(1), std::env::var(TOKEN_FILE_ENV).ok())
        .inspect_err(|_| eprint!("{USAGE}"))?
    else {
        print!("{USAGE}");
        return Ok(());
    };
    let client = Client::new(token_source(args.token)?, github::API_ROOT)?;
    if !args.static_dir.is_dir() {
        println!(
            "review-service: {} is not a directory; build the app (npm run build) to serve it",
            args.static_dir.display()
        );
    }
    let (tx, rx) = watch::channel(Arc::new(State::empty()));
    let refresher = tokio::spawn(refresher(client, tx, args.interval));
    let listener = tokio::net::TcpListener::bind(args.listen)
        .await
        .with_context(|| format!("listening on {}", args.listen))?;
    let shutdown = terminated();
    println!("review-service: serving http://{}", args.listen);
    axum::serve(
        listener,
        server::router(rx, Some(args.static_dir), args.allowed_hosts),
    )
    .with_graceful_shutdown(async move {
        if let Err(e) = shutdown.await {
            println!("review-service: {e:#}");
            std::future::pending::<()>().await;
        }
        println!("review-service: shutting down");
        // Dropping the state's sender ends the event streams, which would
        // otherwise hold the graceful shutdown open.
        refresher.abort();
    })
    .await
    .context("serving")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_env(args: &[&str], env: Option<&str>) -> Result<Option<Args>> {
        parse_args(args.iter().map(|s| s.to_string()), env.map(str::to_owned))
    }

    fn parse(args: &[&str]) -> Result<Option<Args>> {
        parse_env(args, None)
    }

    #[test]
    fn args() {
        let a = parse(&[]).unwrap().unwrap();
        assert_eq!(a.listen.to_string(), DEFAULT_LISTEN);
        assert_eq!(a.interval, Duration::from_secs(DEFAULT_INTERVAL_SECS));
        assert_eq!(a.token, TokenConfig::Gh);
        assert!(a.allowed_hosts.is_empty());
        let a = parse(&[
            "--listen=127.0.0.1:9000",
            "--static",
            "x",
            "--interval",
            "30",
            "--allow-host",
            "a.example",
            "--allow-host=b.example",
        ])
        .unwrap()
        .unwrap();
        assert_eq!(
            (a.listen.port(), a.static_dir, a.interval.as_secs()),
            (9000, PathBuf::from("x"), 30)
        );
        assert_eq!(a.allowed_hosts, ["a.example", "b.example"]);
        assert!(parse(&["--help"]).unwrap().is_none());
        for (bad, why) in [
            (
                &["--interval", "5"][..],
                "--interval must be 30 to 3600 seconds",
            ),
            (&["--interval"], "--interval needs a value"),
            (
                &["--listen", "localhost"],
                "--listen \"localhost\" is not an address and port",
            ),
            (&["--write", "1"], "unknown option \"--write\""),
            (
                &["--octo-sts-scope", "o"],
                "Octo STS needs all of --octo-sts-scope, --octo-sts-identity and --octo-sts-token-file",
            ),
            (
                &[
                    "--github-token-file=t",
                    "--octo-sts-scope=o",
                    "--octo-sts-identity=i",
                    "--octo-sts-token-file=f",
                ],
                "give either a token file or Octo STS, not both",
            ),
        ] {
            assert_eq!(
                parse(bad).err().map(|e| e.to_string()).as_deref(),
                Some(why)
            );
        }
    }

    #[test]
    fn token_args() {
        let token = |args: &[&str], env| parse_env(args, env).unwrap().unwrap().token;
        let file = |f: &str| TokenConfig::File(f.into());
        assert_eq!(token(&[], Some("/run/t")), file("/run/t"));
        assert_eq!(token(&[], Some("")), TokenConfig::Gh);
        assert_eq!(
            token(&["--github-token-file", "/a"], Some("/run/t")),
            file("/a"),
            "the flag wins"
        );
        assert_eq!(
            token(
                &[
                    "--octo-sts-scope=cgwalters-forge",
                    "--octo-sts-identity=control-plane",
                    "--octo-sts-token-file=/var/run/secrets/tokens/octo-sts",
                ],
                None
            ),
            TokenConfig::OctoSts {
                scope: "cgwalters-forge".into(),
                identity: "control-plane".into(),
                token_file: "/var/run/secrets/tokens/octo-sts".into(),
            }
        );
    }
}
