# Control app service

> This text is LLM generated.

A persistent service that builds the control app's state from GitHub
queries rather than from JSON the pass stores in comments, and serves it
read-only with the control app. This is the first slice of review#281.

Initially, then `--interval` seconds after each refresh finishes (default 60,
30 to 3600), it reads:

- **runs**: unfinished Actions runs of every tracker workflow (passes and
  the jobs they dispatch) and of the devspace `agent.yml`;
- **prs**: the bot's open PRs anywhere, each with GitHub's `mergeable_state`;
- **waiting**: open issues and PRs assigned to the operator or requesting
  the operator's review, one entry per item with its reasons.

Run and PR reads are conditional on the last answer's ETag, so an unchanged
answer costs no rate budget; the three searches have no ETags and are what
bounds the interval (search allows 30 a minute).

The existing conditional-response cache is scoped to both request path and a
SHA-256 digest of the credential actually sent. This prevents a rotated token
with different visibility from reusing the previous token's validator or body,
even when both representations have the same ETag. Tokens themselves are not
stored in cache keys. A new token starts with cold reads, including an Octo STS
renewal; unchanged credentials retain conditional reads. Late responses to old
requests stay in their original credential's scope. This also applies to the
Forgejo and Kubernetes clients. The cache remains memory-only and drops entries
not used across refreshes; losing it only causes full reads. No new option,
cache, deployment setting or write authority is added. It does not purge the
last published state on rotation or make retained failure-state facts current;
those keep the section freshness/error contract below.

Each section has `items`, `complete`, `readAt` and `error`. `complete` is
false when a list was longer than the one page of 100 that is read, GitHub
reported incomplete search results, the total count was unavailable, or
part of the section couldn't be read. `error` names every incomplete list
by its GET path and query, with the returned and total counts and the
first-page limit when truncated; pagination remains disabled. It also
says what failed: if the
whole read failed, the section keeps the items it last read and `readAt`
says when that was; if only part did (one run source, or some PRs' merge
states), the rest is fresh and `error` names the first failure and counts
the others. Incomplete-list diagnostics stay visible alongside that summary.

It serves:

- `GET /api/state`: the whole state (`review-service/v1`), including `version`
  and `schemaAliases: ["control-app/v1"]`;
- `GET /api/v1/state`: the same document, with `generation` matching the
  existing full-resync SSE event id;
- `GET /api/repos/OWNER/REPO`: one repository's runs, PRs and waiting
  items, each section with the whole section's `complete`, `readAt` and
  `error`, since a list cut short may be missing this repository's items;
- `GET /api/events`: server-sent events, a `state` event with the whole
  state on connecting and after each refresh. Its id counts refreshes; as
  each event is the whole state, a client reconnecting with `Last-Event-ID`
  gets the current state first, a full resync. A comment every 20 seconds
  keeps idle proxies from closing the stream;
- `GET /healthz`: JSON with `status: "ok"` and `version`, without touching GitHub;
- everything else from the built app (`--static`, default `dist`).

Its GitHub, Forgejo and Kubernetes clients send only GETs. The optional ACP
route below can prompt a running agent; it does not use these forge tokens.
It logs to stdout and exits cleanly on SIGTERM.

The full-state JSON keeps `schema: "review-service/v1"` for existing clients.
The additive `schemaAliases: ["control-app/v1"]` is the recommended migration
mechanism: both names describe the same payload, not different versions.
Both state endpoints and all full-state SSE events include the alias, before
the first refresh, after refreshes and on reconnects.

Both endpoints report `version: {"tag": "v…", "commit": "…"}` with the
release tag and full commit embedded at build time. Each field is `null`
when unavailable (including ordinary local builds), not the Cargo package
version. To identify a local build, set `REVIEW_SERVICE_TAG` and
`REVIEW_SERVICE_COMMIT` in the environment when running Cargo; setting them
only when starting the service does not change its reported identity.

## Running it locally

    npm run build -- --hosted
    cargo run --manifest-path service/Cargo.toml -- --listen 127.0.0.1:8080

and open http://127.0.0.1:8080. Without a token source it uses
`gh auth token`; the token needs only read access.

Anyone who can reach the service reads what its token can, so on any
address but loopback keep it behind a network ACL or an authenticating
proxy. It refuses requests whose `Host` is a domain name other than
`localhost` or an `--allow-host` name, so a web page can't read the state
by pointing its own name at the service's address (DNS rebinding). Behind
a proxy, give the name the proxy forwards in `Host`.

## ACP session bridge (review#315 slice 2)

The concrete threats are a foreign web page prompting the operator's agent,
and a browser choosing an arbitrary internal destination or learning a run's
attach secret. One optional, service-owned configuration supplies the exact
browser origin and the only session destinations the bridge can reach.
**Off by default**, `--acp-config /run/control-app/acp.json` enables
`GET /api/acp/SESSION` as a WebSocket route and `/api/acp` for discovery.
For example, the config file is:

```json
{
  "origin": "https://control.example",
  "sessions": {
    "run-42": {
      "label": "Provider",
      "url": "wss://gateway.example/sessions/run-42",
      "token_file": "/run/secrets/attach-run-42"
    }
  }
}
```

The browser opens that same-origin route with the configured ID, not a URL or
credential. The service reads the secret file for each attachment and sends
`Authorization: Bearer SECRET` only to the configured listener. It sends no
browser cookies, authorization, Origin or proxy-identity headers upstream and
does not follow redirects. Errors are generic; neither config, listener
addresses, upstream response bodies nor secrets appear in HTTP/state/SSE
responses or logs. ACP text messages pass through unchanged, not interpreted
as authorization for forge writes. Binary messages end the connection; ping
and pong are local to each transport, and upstream close reasons are not relayed.

**Keep this behind the existing operator-only authenticating proxy or ACL.**
Origin is a browser cross-site defense, not user authentication: any non-browser
client able to reach the service can forge it. The proxy must protect this route
as well as the app and support WebSocket upgrades. Only an exact, single Origin
is admitted (HTTPS, or HTTP for loopback development); missing, duplicate and
foreign origins are refused before dialing. Existing Host admission still applies.

This targets agentic-job#3319's bearer-authenticated `session.bind` contract at
`283b1fd37b8ac2b5ad70121c5c02a0e0679d4f74`, not the older Tailscale-login-header
listener. A runner/gateway must provision the matching per-run secret out of
band. A hosted tailnet route or self-hosted gateway must preserve this bearer
contract; the bridge does not discover addresses or scrape workflow logs.
`wss` verifies certificates with public roots. Use `ws` only on a trusted or
encrypted network path: bearer authentication alone does not encrypt the secret.

The config is read once at startup, at most 64 KiB, with 1–16 sessions. IDs use
1–64 ASCII letters/digits, `_` or `-`; token paths are absolute. URLs are `ws`
or `wss`, without embedded credentials, queries or fragments. Secret files are
bounded and must contain 32–1024 visible ASCII bytes (surrounding whitespace is
trimmed). Restart to add/remove sessions; replacing a secret affects the next
connection, not an attached one. Removing config does not revoke an existing
connection until shutdown/restart.

The bridge admits at most eight pending/active attachments and one per configured
session, returning 429 rather than queuing. Secret read and upstream handshake
together get ten seconds; each write gets ten seconds. Each text/frame is at
most 1 MiB, with no application queue, five minutes idle and one hour absolute
lifetime. Either disconnect/error drops both sockets; there is no automatic
retry, reconnect or replay. Shutdown may wait for an attachment's bounded
lifetime. A close may end the agentic-job session, depending on its listener
version; do not assume reconnect is supported by #3319.

`GET /api/acp` returns only `[{"id":"run-42","label":"Provider"}]`, never
target URLs, token paths or secrets. Labels default to the ID and are nonblank,
at most 64 UTF-8 bytes, without control characters. Discovery shares the bridge's
Host and exact-Origin admission and must be protected by the same operator-only
proxy/ACL. The service does not authenticate users itself, so that external gate
must cover **all** `/api/acp` paths and methods. `POST /api/acp` is the identical
read-only listing, used by the browser because same-origin GET omits Origin.
Neither method dials an agent; responses are not cached.

The hosted build discovers sessions once on load and shows **Configured chat**
only for a nonempty listing. Choosing a provider attaches through the bridge;
ACP `session/new` returns the run's existing session, not a fresh conversation.
The pinned listener admits only one client. Disconnects/errors show **Session
ended** and explain that a new conversation needs the session server restarted;
the drawer offers neither a fresh-session control nor retry of that destination.
The public Pages build
does not discover configured sessions. No deployment enablement is included.

`fixtures/acp.json` is a **synthetic protocol replay**, derived from that pinned
listener's initialize/new/prompt/update/cancel wire shapes, not a live capture.
The service tests replay it over real loopback WebSockets and check server-only
bearer authentication, rotation, origin/Host admission, disabled/unknown routes,
capacity, upstream refusal sanitization, disconnects, message limits and timeouts.
No live agent, workflow dispatch or deployment enablement is part
of these tests; the first-slice acceptance of exchanging a message with a real
hosted run remains open. There is no deployment config in this repository, and
the caller's repository/file and real route/secret provisioning were not supplied.

## Board decision preview (tracker#1456 phase 1)

### App and CLI decision reads (#292)

The concrete threats are accidentally exposing a private service's data in the
public Pages app and presenting preview facts as permission to write. The
client is off by default. Build the private, same-origin app explicitly with
`npm run build -- --hosted --service-decisions` after configuring the board
preview below. This inserts the app's opt-in marker; ordinary builds still use
GitHub publications. Do not publish this hosted build to Pages. Keep all service
routes behind the operator-only proxy/ACL described above.

The app consumes `/api/events` full-state resyncs, including on reconnect; each
event id must match its document generation. A disconnect marks retained facts
unavailable; a quiet stream does not, since refreshes may be up to an hour
apart, but the publication clock still goes stale. All decision panels use the
same generation, never an older list joined with newer capacity/work. No GitHub
holds, live-workflow or needs-human decision polling runs in this mode.
Independent project status and explicit inspections still use the viewer's
GitHub token when supplied. The service view is always read-only, token or not,
because its write checks would rest on preview facts; no token is sent to the
service. CLI act-command authorization is unchanged.

`CONTROL_APP_SERVICE=https://control.example control-app needs-you` selects the
same adapter for CLI `status`, `needs-you`, `act-now`, `repo` and `changes`. The
URL is supplied by the caller, not compiled into the app. These commands send
one credential-free GET to `/api/v1/state`, with no redirects, a 15-second timeout
and a 2 MiB body bound. Schema validation reuses the publication readers and
their inventory bounds. Service failure never silently switches to GitHub.
Queue reads and act commands deliberately retain their independent GitHub path.

For CLI `needs-you` and `act-now`, `complete` requires both the service decision
and its nested needs-you list to be complete. `listComplete` separately reports
the nested list's coverage (null when unavailable); a complete list cannot hide
a partial preview. Partial decisions retain known cards/rows in producer order,
but `needs-you` never reports them as settled. Freshness and read failures remain
separate from coverage: inspect `unavailable` as well as `complete`. This changes
only the existing opt-in CLI reads, not static reads or write authorization.

The service decision contract supplies holds, needs-you, shortlist, work, WIP
and pool evidence; missing candidate/usage readings remain unknown. It does not
supply pass history or run receipts: these are explicitly unavailable, and
`changes` reports that gap rather than comparing unrelated publications. Local
epic filters remain, but the service's inbox and shortlist retain producer order.
Partial source coverage and omitted counts remain visible. HTTP delivery never
advances a publication/source clock or certifies an irreversible action.

`test/fixtures/service-decision-producer.json` is the pinned producer's own
`/api/v1/state` output from the Rust refresh/HTTP/SSE test, which fails when it
drifts (`UPDATE_FIXTURES=1 cargo test` rewrites it); the TypeScript tests replay
it through HTTP, UI and CLI. `test/fixtures/service-decision.json` is a
hand-written projection of the same serialization (including nullable Work
options) for the needs-you and shortlist cases that replay lacks. Browser replay
drives full resyncs without a token and checks no GitHub requests, producer
order, unavailable disconnects and desktop/phone rendering.
No deployment or token permissions are changed here.

Board reads are **off by default**. To try the integration locally, supply
your own GitHub `agent-board.json`, in the format accepted by the pinned
board-forge revision, and the same read-only token source as above:

    cargo run --manifest-path service/Cargo.toml -- \
      --listen 127.0.0.1:8080 --board-config /path/to/agent-board.json \
      --github-token-file /path/to/read-only-token

For tracker's board, obtain `.github/poll/agent-board.json` from
`cgwalters-forge/tracker` into a local file; do not copy deployment prompts
into this service. The config is read and validated once at startup (at
most 1 MiB); restart to change it. No deployment or caller workflow is
changed here. The service supports GitHub boards, not Forgejo boards.

The threat stopped by keeping this opt-in is accidental access to another
board's private data and consumption of its API budget. Once enabled, each
refresh calls the exported board-forge `pass::decision::preview` once,
not a second scheduler. It admits at most 128 forge requests over 45
seconds, with a 10-second per-request timeout and a 2 MiB response limit.
Exhaustion is incomplete evidence, not a successful empty board. These
bounds apply to the added preview, not the existing runs/PR/waiting reads.
There are no retries or overlapping refreshes.

Successive ticks must not keep spending a throttled forge's budget. The same
refresher therefore keeps in-memory pacing across previews, without another
loop or cache. Failed previews back off 30, 60, 120, 240, 480, then at most
900 seconds, measured from completion. A rate-limit response (including
GraphQL errors), or zero remaining requests, also closes request admission
within that preview. Numeric reset and Retry-After evidence (seconds or HTTP
date) survives skipped ticks. The greater hint is used, bounded to 30–3600
seconds; a hint beyond one hour is capped, not a promise to wait indefinitely.
Only parsed numbers are published, never upstream header/error prose. The
longer of this cooldown and failure backoff wins. A failure-free preview
resets pacing; missing coverage alone is not success or authority. Concurrent
wakes coalesce without queuing work. Slow refreshes wait a whole interval
after completion rather than spending a second budget on an overdue tick.

Aborting a refresh must not leave its synchronous library worker issuing
detached requests. Cancellation closes that worker's admission and aborts its
active async request, including token acquisition. Its permit remains held
until the blocking worker exits, so cancellation cannot enable an overlapping
preview. SIGTERM aborts and awaits the refresher before closing SSE. Cancellation
does not wait for a full preview: the active request has a ten-second timeout
and the synchronous waiter an additional one-second allowance (eleven seconds
maximum for request work); the worker cannot start subsequent requests. This
is a preview-request bound, not a bound on the optional ACP shutdown lifetime.

The threat stopped by the read-only transport is an accidental applying
path writing a comment, changing labels, merging, rerunning or dispatching
a job. It refuses all non-GET REST methods, GraphQL documents containing a
`mutation` token, and downloads, independently of the library's preview
guard. Only GitHub API-origin requests receive the token; redirects are
not followed. File tokens are reread for every request, and Octo STS shares
the existing rotation/exchange logic. **Keep the token read-only**: Projects
read may be needed for the supplied board, but do not broaden a deployed
token's permissions as part of enabling this preview. `poll.yml` remains
the sole writer; preview starts are proposals, never execution receipts.

When enabled, `/api/v1/state`, `/api/state` and the `state` SSE payload
include an additional `decision` section. Its `items` has zero entries
before observation, then one `agent-board/decision/v1` snapshot. The
snapshot retains board-forge's coverage, omitted counts, per-source clocks,
carried evidence, provenance and confirmed effects. A partial observation
replaces the prior snapshot with fresh partial evidence; a failure before
observation keeps the prior items and `readAt`, sets `complete: false` and
reports an error. With no prior snapshot it remains unavailable, not an
empty successful result. Missing or stale usage is not upgraded merely
because the preview ran. Broker reads are deliberately unavailable in this
first integration: board-forge may use published forge evidence with its
original timestamps; missing evidence stays missing. The service contacts
no inference endpoint and accepts no inference credential. Configured
private URL hosts and tokens used during the read are redacted from the
projection. Published prose is also screened independently for addresses
and credential formats, including older installation tokens; raw
transport/config errors are not published or logged. Typed not-found,
authentication and rate-limit failures retain board-forge's semantics,
including its rate-limit breaker, without exposing upstream error bodies.

Throttled, skipped and coalesced previews likewise retain the prior snapshot
and its `readAt` with an explicit incomplete/error state. The additive
`decisionRefresh` sibling reports `lastSuccessAgeSeconds` (null until a
preview has no read failures), `retryInSeconds`, `consecutiveFailures`, the
last parsed `rateLimit` evidence, and `requests` admitted in the last attempted
preview. Ages/countdowns are sampled at publication, not on HTTP reads. A
successful computation can still have incomplete coverage; this metadata
never changes the snapshot's source clocks, completeness or confirmed effects.
Restart discards pacing and success age, not authority or writer state.

One watch-channel replacement publishes the legacy sections and decision
together. The versioned HTTP endpoint does not run a preview: it returns
that exact published generation. SSE's id and the document's `generation`
are equal; reconnecting gets the current full document, not a delta or a
recomputation. Runs, PRs, waiting, repository filtering and section errors
keep their existing contracts. Disabled instances omit `decision` entirely.
The preview captures its own observation clock after the legacy reads;
`refreshedAt` is the publication clock, not a source validation timestamp.

The dependency is pinned to immutable agent-board revision
`7a1af07d7ffd10d2048efb98ba8010eb2f1e0c95` (includes #799's snapshot API).
As of this integration, agent-board#794 is open. `board::Reader::refresh`
is the explicit direct-read/cache seam: every preview receives fresh
disposable pass state; no second response cache is implemented. Repeated
reads and loss/restart produce the same evidence at the same clock, but
**warm-cache acceptance remains open** pending #794's reusable API and
fixtures. Losing this service's memory loses no authority or durable state;
the legacy REST ETag cache is unchanged. This is not completion of #281 or
the tracker#1456 epic. Opt-in decision consumers are described above; full
service browser integration remains #281.

## Forgejo source (review#310 a)

Forgejo reads are **off by default**. With `--forgejo-url URL`, the
instance's base URL, and `--forgejo-token-file PATH`, a file holding a
read-only token that is reread for every request like the GitHub token
file, each refresh reads with GETs only:

- with `--forgejo-org ORG` (up to 10) and `--forgejo-label LABEL` (up to
  20), both repeatable: open issues in each organization carrying any of
  the labels, one search per organization. Forgejo drops label names it
  doesn't know, and with none left it doesn't filter by label at all, so
  the service keeps only issues carrying a configured label, by exact name,
  and reports any others it dropped as a failure;
- with `--forgejo-reviewer USER`: open PRs requesting that user's review.
  Forgejo's search lists only the token user's requested reviews, so the
  service checks `GET /user` names the reviewer and reports a failure
  instead of the search if not, rather than show someone else's reviews
  as the operator's.

The token needs read scopes only: `read:issue`, `read:repository` and,
with `--forgejo-reviewer`, `read:user`.

The code names no instance, organization or label; all of it is
configuration. Keeping it opt-in keeps a deployment that isn't given an
instance from contacting one. The results are their own `forgejo` section
of the state, beside GitHub's `waiting`, with the same `complete`, `readAt`
and `error`. Each item has `repository` (OWNER/REPO on the instance),
`number`, `url`, `title`, `pullRequest`, `draft`, `labels`, `reason`
(`labeled` or `review-requested`) and `updatedAt`, most recently updated
first. Each search reads one page of at most 50, or the instance's
`max_response_items` (read from `/settings/api`) if lower; a full page
makes the section incomplete. The searches run at once, alongside the
GitHub reads, each with a 15-second timeout. A failed search makes the
section incomplete and names the failure while the others' items stay;
when nothing could be read, the section keeps its last items and reports
the error. The section is absent when Forgejo isn't
configured, and `/api/repos/OWNER/REPO` doesn't include it. Like the rest
of the state, it is served only to whoever can reach the service; the app
renders it in the hosted personal-infra panel.

## Kubernetes source (review#310 b)

Kubernetes reads are **off by default**. With `--kubernetes-namespace NS`,
repeatable up to 10 times, each refresh lists with GETs, in each of those
namespaces of the cluster the service runs in:

- Flux Kustomizations (`kustomize.toolkit.fluxcd.io/v1`): `ready` (the
  Ready condition; null when Unknown), its `message`, and
  `appliedRevision`;
- Deployments: `images`, one per container of the pod template with its
  `container`, `image` and `tag` (null for an untagged or digest-only
  reference), the desired `replicas`, `readyReplicas`, `updatedReplicas`,
  and `rollingOut`, decided as `kubectl rollout status` does: the
  controller hasn't observed the latest spec, or fewer replicas are
  updated than desired, or old or unavailable ones remain;
- pods, other than finished ones, that have a `problem`: `crash-looping`
  (a container in CrashLoopBackOff), `pending` (Pending for at least 5
  minutes, so a pod that is just starting isn't listed) or `restarting`
  (a container that restarted after terminating within the last hour, so
  old restarts aren't listed), the first that applies, with `phase`, total
  `restarts` and a `reason`: the waiting or last termination reason, or
  the scheduling reason.

Each item has a `kind` (`Kustomization`, `Deployment` or `Pod`),
`namespace` and `name`, and they come in configured namespace order, each
namespace's Kustomizations, Deployments and pods in the API server's order.

It uses in-cluster config only: the API server from
`$KUBERNETES_SERVICE_HOST` and `$KUBERNETES_SERVICE_PORT`, the pod's
automounted service-account token, reread for every request as the
kubelet rotates it, and the cluster's CA as the only trusted root. The
service fails at startup when a namespace is given outside a cluster.

The code names no namespace; they are configuration. Keeping it opt-in
keeps a deployment that runs in a cluster from listing that cluster's
workloads to whoever can reach the service. Listing only the configured
namespaces lets the service account have a namespaced Role in each of
them rather than a ClusterRole that reads every namespace. It needs
`list` on `pods`, `deployments` in the `apps` group and `kustomizations`
in the `kustomize.toolkit.fluxcd.io` group, and nothing else; in
particular not Secrets. A namespace without Flux's API, or where a list
is refused, shows as a failure while the other lists' items stay.

Each list reads one page of at most 200; a longer list makes the section
incomplete. The lists run at once, alongside the GitHub reads, each with
a 15-second timeout. Failures and the last items are kept as in the other
sections. The section is `kubernetes` in the state, absent when no
namespace is configured, and `/api/repos/OWNER/REPO` doesn't include it.
The hosted app renders it beside Forgejo in the personal-infra panel.

### Hosted personal-infra panel (review#310 c)

The concrete threat is the public Pages app fetching private infrastructure
data. The default build therefore contains neither the panel entry point nor
its API reads. `npm run build -- --hosted`, used by `service/Containerfile`,
adds the panel and permits same-origin connections in the CSP. Never publish
that build to Pages. No data is fetched or pre-rendered during either build.

The existing private-network ACL or authenticating proxy is the operator gate;
GitHub sign-in is not that gate. The panel is absent unless the service reports
at least one configured source. No additional source option is needed. It reads
`/api/v1/state` once per minute while visible, without overlapping requests,
with a 15-second timeout and no browser persistence or export. Forgejo's Needs
you remains separate from GitHub. Kubernetes shows readiness, revisions,
images/tags, rollout counts and troubled pods. Each source labels incomplete,
unavailable, stale (over five minutes) and future-clock observations; failures
are not healthy empty lists. Failed refreshes remove displayed old facts.

To prevent unbounded DOM growth and executable upstream prose, rendering is
text-only, capped at 6,000 items per source, 100 images per deployment and
4,096 characters per field; overflow is labelled. Forge links accept HTTPS
only. Tests reuse the recorded source-state fixtures, never live infra data.

## Token sources

The token never comes from a flag or environment value, which leak into
process listings and crash reports. One of:

- `--github-token-file PATH`, or `$GITHUB_TOKEN_FILE`: a file holding the
  token, reread for every request so a rotated Secret takes effect;
- Octo STS, with `--octo-sts-scope`, `--octo-sts-identity` and
  `--octo-sts-token-file`: see below;
- neither: `gh auth token`, for local runs.

### Octo STS

Under Kubernetes, the service can exchange its pod's service-account token
at [Octo STS](https://github.com/octo-sts/app) for a short-lived GitHub App
installation token. Project a service-account token with audience
`octo-sts.dev` into the pod and pass its path as `--octo-sts-token-file`.
The kubelet rotates that file, so the service reads it again for every
exchange; it exchanges again 45 minutes after the last exchange, before
the hour-long installation token expires. Egress then needs octo-sts.dev
as well as api.github.com.

`--octo-sts-scope` names the organization (or `OWNER/REPO`) and
`--octo-sts-identity` the trust policy, `IDENTITY.sts.yaml` under
`.github/chainguard/` in that organization's `.github` repository (or in
the repository). The service's trust policy lives in the public
[cgwalters-forge/.github repository](https://github.com/cgwalters-forge/.github),
not in this repository. Keep issuer URLs and deployment details out of
this README. A policy needs:

- `issuer`: the cluster's OIDC issuer URL exactly, not a pattern;
- `subject`: the service account exactly,
  `system:serviceaccount:NAMESPACE:NAME`;
- `permissions`: read only: `actions`, `issues` and `pull_requests`
  `read` (metadata comes with any), and nothing that writes;
- for an organization policy, `repositories` limited to what the service
  reads, if not all.

An installation token reads only its installation's repositories, so
search results and run sources outside that organization are missing;
a run source it can't read shows as a failure in the runs section.

## Container

`service/Containerfile` builds an image on ubi-minimal holding the service
and the built app; build it from the repository root:

    podman build -f service/Containerfile -t control-app .
    podman run --read-only --tmpfs /tmp -p 8080:8080 \
      -v ./token:/run/secrets/github-token:ro,Z \
      control-app --github-token-file /run/secrets/github-token

It runs as UID 65532, listens on 0.0.0.0:8080 by default, writes nothing
and keeps no state, so it runs with a read-only root filesystem and needs
only a `/tmp` for scratch. Pushing a `v*` tag publishes
`ghcr.io/cgwalters-forge/control-app:TAG` (`.github/workflows/image.yml`).
For one release, the same image is also published as
`ghcr.io/cgwalters-forge/review-service:TAG` so existing deployments keep
working while they migrate. The service executable, help and logs use
`control-app`; the image's entrypoint is `/usr/local/bin/control-app`.
`/usr/local/bin/review-service` remains a working compatibility symlink to
that executable, accepting the same flags. The Cargo package name remains
`review-service`; CLI aliases and Octo STS identity/trust-policy names are
unchanged. The wire schema remains `review-service/v1`, with the additive
`control-app/v1` alias described above.

That workflow supplies `REVIEW_SERVICE_TAG` and `REVIEW_SERVICE_COMMIT` as
container build arguments, embedding the pushed tag and commit in the binary.
Manual image builds can supply the same `--build-arg` values; omitted values
are reported as `null`.

## Tests

`cargo test --manifest-path service/Cargo.toml` checks the state model
against the answers in `fixtures/github.json`, the conditional requests
against a local fake GitHub, the token sources against a fake Octo STS,
and the endpoints and events. The Forgejo section is checked against the
recorded answers in `fixtures/forgejo.json`, giving
`fixtures/forgejo-state.json`, and the Kubernetes section against those
in `fixtures/kubernetes.json`, giving `fixtures/kubernetes-state.json`.

The added preview tests use a local fake forge for cold/repeated/lost state,
partial board reads, stale usage, missing broker evidence and token rotation,
and check effect rejection, read bounds, redaction and HTTP/SSE generation
parity, including failed, deferred and recovered generations. Paused-clock
tests exercise slow ticks, completion spacing, repeated capped backoff,
freshness and shutdown; scripted HTTP reads exercise repeated throttling,
concurrent-wake coalescing and cancellation during a slow response. The empty
synthetic direct-read fixture sends 10 requests cold and 10 per repeated
preview when admitted, with no warm-cache savings. The throttle fixture sends
one per admitted attempt and zero across ten skipped ticks; charged requests
and live rate limits were not measured. Warm-cache checks await
agent-board#794's reusable read-only preview API (merging #798 alone does not
return reusable cache state from `decision::preview`). The hosted personal-infra
panel reads the service; migration of the GitHub browser remains a follow-up.
