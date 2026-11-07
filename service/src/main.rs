//! review-service: builds the control plane's state from GitHub queries on
//! a timer and serves it, read-only, with the app. See service/README.md.

mod github;
mod server;
mod state;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use anyhow::{Context, Result, bail};
use tokio::sync::watch;

use crate::github::Client;
use crate::state::State;

const USAGE: &str = "Usage: review-service [--listen ADDR] [--static DIR] [--interval SECONDS]

Build the control plane's state from GitHub queries every --interval
seconds and serve it read-only: /api/state, /api/repos/OWNER/REPO, and
/api/events (server-sent events), with the built app (DIR) at /.

  --listen ADDR        where to listen (default 127.0.0.1:8787)
  --static DIR         the built app to serve (default dist)
  --interval SECONDS   refresh period, 30 to 3600 (default 60)

The token comes from $GH_TOKEN, else $GITHUB_TOKEN, else
`gh auth token --hostname github.com`; it needs only read access.
";

const DEFAULT_LISTEN: &str = "127.0.0.1:8787";

const DEFAULT_STATIC: &str = "dist";

/// Each refresh makes three searches, and search allows 30 a minute.
const INTERVAL_SECS: std::ops::RangeInclusive<u64> = 30..=3600;

const DEFAULT_INTERVAL_SECS: u64 = 60;

struct Args {
    listen: SocketAddr,
    static_dir: PathBuf,
    interval: Duration,
}

fn parse_args(mut args: impl Iterator<Item = String>) -> Result<Option<Args>> {
    let mut listen = DEFAULT_LISTEN.to_owned();
    let mut static_dir = PathBuf::from(DEFAULT_STATIC);
    let mut interval = DEFAULT_INTERVAL_SECS;
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
            "--static" => static_dir = value.into(),
            "--interval" => {
                interval = value
                    .parse()
                    .with_context(|| format!("--interval {value:?} is not a number of seconds"))?
            }
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
    Ok(Some(Args {
        listen,
        static_dir,
        interval: Duration::from_secs(interval),
    }))
}

fn token() -> Result<String> {
    for var in ["GH_TOKEN", "GITHUB_TOKEN"] {
        if let Ok(t) = std::env::var(var)
            && !t.trim().is_empty()
        {
            return Ok(t.trim().to_owned());
        }
    }
    let out = std::process::Command::new("gh")
        .args(["auth", "token", "--hostname", "github.com"])
        .output()
        .context("no $GH_TOKEN or $GITHUB_TOKEN, and running `gh auth token` failed")?;
    let t = String::from_utf8(out.stdout).unwrap_or_default();
    if !out.status.success() || t.trim().is_empty() {
        bail!("no $GH_TOKEN or $GITHUB_TOKEN, and `gh auth token` gave none");
    }
    Ok(t.trim().to_owned())
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
                eprintln!("review-service: {name}: {e}");
            }
        }
        tx.send_replace(Arc::new(next));
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let Some(args) = parse_args(std::env::args().skip(1)).inspect_err(|_| eprint!("{USAGE}"))?
    else {
        print!("{USAGE}");
        return Ok(());
    };
    let client = Client::new(token()?, github::API_ROOT)?;
    if !args.static_dir.is_dir() {
        eprintln!(
            "review-service: {} is not a directory; build the app (npm run build) to serve it",
            args.static_dir.display()
        );
    }
    let (tx, rx) = watch::channel(Arc::new(State::empty()));
    tokio::spawn(refresher(client, tx, args.interval));
    let listener = tokio::net::TcpListener::bind(args.listen)
        .await
        .with_context(|| format!("listening on {}", args.listen))?;
    eprintln!("review-service: serving http://{}", args.listen);
    axum::serve(listener, server::router(rx, Some(args.static_dir)))
        .await
        .context("serving")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Result<Option<Args>> {
        parse_args(args.iter().map(|s| s.to_string()))
    }

    #[test]
    fn args() {
        let a = parse(&[]).unwrap().unwrap();
        assert_eq!(a.listen.to_string(), DEFAULT_LISTEN);
        assert_eq!(a.interval, Duration::from_secs(DEFAULT_INTERVAL_SECS));
        let a = parse(&[
            "--listen=127.0.0.1:9000",
            "--static",
            "x",
            "--interval",
            "30",
        ])
        .unwrap()
        .unwrap();
        assert_eq!(
            (a.listen.port(), a.static_dir, a.interval.as_secs()),
            (9000, PathBuf::from("x"), 30)
        );
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
        ] {
            assert_eq!(
                parse(bad).err().map(|e| e.to_string()).as_deref(),
                Some(why)
            );
        }
    }
}
