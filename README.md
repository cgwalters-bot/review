# review

A small, fast review interface for work proposed by
[cgwalters-bot](https://github.com/cgwalters-bot) (and by people): a
prioritized queue of questions and actions, forge draft PRs with their diffs
and commit messages, in-place rewording, DCO sign-off as yourself, and
`/promote`. It works against GitHub and against a Forgejo instance.

The rule it is built around: **the forge, git and markdown are the source
of truth**, and the app keeps no database of its own. The queue is the
Workstream board and its issues; answers and edits are made as you, on the
forge. It is two thin client-side apps (GitHub and Forgejo), served
tailnet-only, plus a stateless token relay that GitHub's OAuth requires.

Status: v0 of the GitHub app. Read [docs/design.md](docs/design.md),
starting with its revision at the top: for now the backend is the
Workstream board and its issues, not an items repository. The earlier
claude.ai-hosted prototype, and why it is being replaced, is described in
[docs/prior-prototype.md](docs/prior-prototype.md).

## What v0 does

One ranked queue of everything waiting on you: the bot's open draft PRs
in cgwalters-forge that you haven't approved or sent back at their
current head, the bot's other PRs with something only you can do, and
the Workstream board's "Needs human" items and Draft items (gists to
read). Once a PR is open, everything about it happens on the PR, so
those PRs are listed from GitHub itself, not from tracker asks:

- **review requested**: its open PRs anywhere that request your review
  (`is:pr is:open author:cgwalters-bot user-review-requested:cgwalters`).
  GitHub drops the request once you review, so a PR you reviewed leaves
  the queue until the bot requests it again.
- **approve to re-sign**: its upstream PRs whose DCO check fails on
  commits lacking your `Signed-off-by`. Approving the head is your
  sign-off: the bot then adds it with `bot-pr signoff`.
- **rerun**: its upstream PRs (unless conflicting) whose
  required checks (the base branch's rulesets; classic branch
  protection isn't readable) failed in GitHub Actions,
  with a "Rerun failed jobs" button per run for a flake.
- **the bot responded**: PRs where you requested changes and the bot
  pushed or replied since.

PRs where you requested changes and the bot hasn't pushed or replied
since are listed last, under "Changes requested, waiting on the bot":
none of them is yours. P0 comes first (the board's Priority; a PR takes
its board item's, found by the item id in a forge PR's bot-meta, else by
the PR's URL in an item's Branch, In Review items included), then the
oldest. A decision with no PR is an issue in cgwalters-forge/tracker, a
question (or a chore), nested under the item it blocks; older review
and chore asks about PRs still show until the bot closes them. Asks you
answered, or the bot closed, move to the end until the bot acts. A
Needs human item with neither an open ask nor a PR listed for you is
flagged as a bot bug. A board item that is itself a PR listed here (as
`bot-land` adds the bot's own) is that PR's row, never a second one.
A board item whose own issue or PR is closed or merged is left out,
whatever its Status still says, and named in a folded note at the end
of the queue: the board is behind, and the bot should move it to Done.

- **A PR** opens a review pane (the form is there for the bot's PRs in
  its own space, and for the PRs listed for your review): the description (without bot-pr's
  meta section), CI checks, every commit with its full message, and the
  diff. **Approve** submits an approving review of the head you were
  shown, which is what `bot-pr promote` acts on; if the head moved
  meanwhile, nothing is sent, and the confirmation names the files you
  never expanded and the review guide's hotspots you never saw. A
  checkbox adds the `/draft` line that asks promote for a draft upstream
  PR. **Request changes** and **Comment** submit reviews with your text.
- **Make it mine**, on the bot's forge PRs, is for upstreams whose
  contribution policy is human-text: the title, description and commit
  messages must be yours. You edit them in place, starting from the
  bot's text as it is: nothing saves while any field still has a
  `Generated-by` line, a title promote would refuse (the bot's), or
  without your "This text is mine". You check every change as a diff,
  and push: with your token the app rewrites each commit with your
  message and you as committer (same tree, parents and author, checked
  for each new commit), moves the branch only if it is still at the
  head you were shown (a compare-and-swap through GraphQL's
  `updateRefs`), sets the title and description (keeping the bot-meta
  section, and re-reading the body first), and comments `/promote
  --human-text` once GitHub shows the push on the PR. That comment
  approves the new head, so it is ticked by default only if you
  approved the head it replaces (the code is the same); otherwise the
  confirmation says what you haven't seen, as Approve's does. The
  committer starts as promote's sign-off identity. GitHub then records you as the one who pushed the
  head, set the title and edited the body last, which is what `bot-pr
  promote` checks. Only `bot/` branches of the bot's PRs within a
  cgwalters-forge fork, and no code edits yet.
  `test/e2e/make-it-mine.ts` runs it against a scratch PR.
- **The diff** is unified or split (remembered per browser), syntax
  colored, with word-level changes marked and the unchanged lines
  between hunks expandable from the file at the head. A file tree gives
  each file's counts; "Viewed" marks are kept per file version, so they
  clear when the file changes; generated, vendored and lock files and
  test fixtures start collapsed. You can view one commit, or a range of
  them, instead of the whole PR. Clicking a line number (or `c` on the
  focused line) writes a line comment, shift-click a range; comments wait
  in the form and go out with your review, those written on an earlier
  commit viewed alone in a comment-only review of that commit.
- **The review guide**, when the bot's reviewer posted one
  (`bin/bot-review-guide` in homegit), lists where it thinks the PR
  needs a close read: a summary, hotspots in reading order with a
  severity and a reason, and what is safe to skim. Hotspot lines are
  tinted in the diff with the reason right above them, and `g` walks
  them in order. Only the bot's own COMMENT reviews count, only for the
  head they name: after a push the guide shows as stale. Its text is
  shown as plain text, and it is advice: it doesn't replace reading.
- **A board item** shows its Why, links, description, gist and latest
  comments, rendered from markdown and sanitized. A parent issue in
  cgwalters-forge/tracker also shows its sub-issues and their progress.
- **A question** is an issue in cgwalters-forge/tracker labelled
  `question`. You answer with a tap on one of the options it offers (the
  recommended one is A), free text, or both; the answer is a plain
  comment by you on that issue, whose first line is the letter you
  picked. The bot acts on it and closes the issue. Upstream issues and
  PRs are never answered from here: they link to GitHub.
- **A review** ask (label `review`, deprecated: the bot now requests
  your review on the PR itself) opens the PR it names in the review
  pane, upstream PRs included, showing the head the bot asked about and
  warning if the PR moved since (reviewing the new head needs your
  confirmation). Approving or requesting changes also comments on the
  ask so the bot sees it.
- **A chore** (label `chore`) shows what the bot asks and a comment box.
  One naming workflow runs lists their failed jobs, with a "Rerun failed
  jobs" button per run: after you confirm, it reruns them with your
  token (you need write access to that repository) and comments on the
  chore.

**After an action** (approving or requesting changes, answering a
question, commenting on a review or chore, rerunning a chore's jobs,
Make it mine), the queue shows its effect at once, re-reads the board
and the forge without waiting for the next poll, and re-reads the
entry itself. GitHub's search and reviews can lag a write, so a review
sent from here counts as given until a read agrees (or five minutes
pass). Then the app opens the next entry of the list you opened it
from, in the order you saw it, with a small "Done: … → …" line and a
link back; with nothing left, the queue says you're all caught up. It
stays put when the action failed, when the entry still waits on you
(a comment-only review), when you left for another view meanwhile, or
when you have unsent text elsewhere on the page. An item opened from
the themes under By priority moves on in their order instead, among
its items that are in the queue, and one from By priority in that
list's. An answer given in a Needs you row moves on in place, to the
next row still waiting on you. "Auto-next"
in the header turns this off (remembered per browser).

**Operator dashboard.** Under "Ask anything", **Decisions** contains only
current concrete asks: unanswered open tracker questions assigned to the
operator, non-draft PRs explicitly requesting the operator's review of an
unreviewed head (any author), and open items labelled `escalate` assigned to
the operator. PRs approved by the operator at the current head are excluded,
including human-text forks. Bot review guides are advisory; the dashboard
does not infer approval or human-text promotion readiness from them.
Rows show **Answer**, **Review**, or **Write text**, the reason,
ask age and repository reference. P0 comes first, then the blocked epic's
priority, then the newest ask. Missing request timestamps are shown as
unknown rather than using the PR's creation date. Other queue entries and
decisions beyond the first fifteen are in collapsed **Watching**.

**Weekly subscription usage** is first on the dashboard, always visible. It
reads Claude and OpenAI from `bot-usage/v1`'s `pools`, one compact row each: a
thin bar of the percent used with a tick where the pace allows, coloured as a
warning when over pace or held, and a short label that also says held or
stale. Each row expands to the exact percentages, reset time and when it was
observed. When the snapshot has a `mistral` object (the broker's requests and
tokens since it started; it has no plan window, so no bar or pace) a plain
counter row follows them. Older publications retain the Claude window display.
**Status** comes right after usage, then the open questions, with Decisions open on entry,
ranked by Priority, showing what they block and their inline answer forms.
Each question leads with what it asks, then one small line (priority, the
issue as a link to GitHub, how long it has waited), its options as radio
buttons (the recommended one marked, none picked for you), a short text box
and Send. Chips over the rows (All, P0, P1, P2, each with its count) filter
them by priority; the choice is remembered in this browser, and picking one
never discards a half-written answer. Who may answer is said once, over the
rows: nothing for cgwalters, the login for anyone else. If GitHub didn't say
whose token this is when the page started (offline, a suspended phone), the
page uses the login the cache was filled as, asks again at each poll, and
meanwhile still offers the forms, saying that answers post as the token's
owner.

**From people**, after Decisions, is a closed-by-default opt-in disclosure.
Opening it starts its reads; while closed, people notifications are not polled.
It combines open human-authored PRs requesting
the operator's review (`review-requested:cgwalters -author:cgwalters-bot`)
with participating unread mention/review-request notifications from the last
14 days. Notifications require a recent explicit human comment/review mentioning
the operator or a human review-request event; unknown actors and bot-only
activity are excluded. Matching threads appear once. Five rows show before
View all, with author, request age (unknown when unavailable), CI, and GitHub
Review/Reply links. Mark done marks the notification read on GitHub; an open
search review request stays until reviewed. The header shows people and bot
ask counts. No separate inbox or dismissal state is stored.

Notifications need access to the signed-in operator's notifications: a classic
token needs the `notifications` scope (or `repo`, which also grants access).
Fine-grained tokens do not support these notification endpoints. When access
is unavailable, the section shows a warning and retains review-request search
results. Repository access is still needed for private PRs, timelines and CI.

Questions retain their inline answer forms and draft protection. Reviews
open the existing head-checked review pane; **Write text** on an escalation
opens its GitHub issue.

**Status** renders the newest ProjectV2 status update as sanitized markdown,
with a four-line preview and Expand. **Focus** shows active epics by priority,
sub-issue progress and running child items; paused or parked epics are gray.
**Agents** shows remote/local placement, engine, item and age, the count
against `AGENT_TARGET`, and OpenCode's share. Engines come from the optional
board Engine field or heartbeat worker `engine`; absent engines stay unknown.
The running count combines live `agent.yml` Actions runs (remote) and fresh
heartbeat jobs without a devspace (local). The board's Lead/Run fields supply
context, never proof of execution: completed or unvalidated Run links and
Lead-only claims remain unconfirmed. Board claims cannot rescue a stale,
stopped, cached or unread heartbeat. Lead-only epics and sub-issue umbrellas
stay in Focus and are excluded from agent claims.

Remote sightings are merged by repository plus concrete run id, ignoring URL
case, attempt suffixes, queries and fragments. A remote heartbeat worker can
be associated through its board item's Run link; without a validated live
Actions run it remains unconfirmed. A local heartbeat job stays distinct even
when its item also links to a remote run. Duplicate heartbeat worker names
within one session count once. Retained Actions rows after a failed/cached
read, or readings older than two 60-second poll intervals, are unconfirmed.
Actions-only counts render even when board and heartbeat reads fail; agents
with unknown engines stay unknown in the OpenCode share. Counts include only
known execution; inaccessible or truncated sources may hide additional jobs.

**Live Actions runs** is visible outside the Agents and ops disclosures. It
reads `agent.yml` independently of the heartbeat, conditionally every 60 seconds
while the dashboard tab is visible. Rows link to Actions and expand to show
the attempt, actor, timestamps, job status, runner and labels. The last-24-hour
summary counts runs created in the window; core-hours sum job spans clipped to
that window, using only runner labels that report a core count. The sparkline
shows those known core-hours per hour. Lists are bounded to 100 runs per query
and 100 jobs per attempt; truncation or missing job sizes makes totals partial.
Active statuses are queried separately so older live runs can still appear.
Only the latest attempt's jobs are included; retries make accounting partial.

Model usage can be explicitly published in a run's `display_title`, for example
`Agent: review [tokens=1200; cost=$0.25]`. The conservative parser accepts
standalone `tokens` or `cost` fields, separated from other text by brackets,
parentheses, semicolons, pipes or `·`; a comma separates fields only when
followed by another `tokens` or `cost` label. Labels are case-insensitive and
use `:` or `=`. Tokens must be an unsigned integer; cost must have an explicit
`$` or `USD ` prefix and an unsigned decimal with at most six fractional digits.
For example, `(TOKENS: 0 | cost: USD 0.125)` is also supported. Signs, exponents,
abbreviations (`1k`), thousands separators, other currencies, bare costs,
trailing prose and duplicate labels are unsupported. Each metric is independent:
an absent, malformed, duplicate or unsafe numeric value remains `null`.

The shared state and panel sum known title readings for runs **created** in the
last 24 hours, with separate known-run counts and partial flags for tokens and
USD cost. Explicit zero is known; no readings is unknown (except a successfully
read, complete empty window, whose sum is zero). Active runs, missing readings,
truncated history and retries make coverage partial. Costs are summed in integer
millionths of USD; an unsafe aggregate remains unknown. These run-level readings
are not prorated into the window or treated as exact 24-hour consumption. No
artifact downloads, pricing estimates or conversions from runner time or the
plan's five-hour/seven-day windows are used.

The menu's **state.json** (`#state.json`) displays the serializable
`review-state/v1` snapshot; **Copy state** copies the same model. It includes
status, people (concrete asks), decisions, agent summaries, Focus board items,
Actions runs/metrics, usage, and per-source check times/errors. Published
heartbeat/usage timestamps distinguish a fresh fetch from an old publication.
Unfetched sources are pending; inaccessible or absent sources are explicit.
The snapshot contains no authentication token, but does contain the board and
private usage data visible to the signed-in user.

With Node 22.18 or later, the same loaders and model run on the command line:

```sh
GH_TOKEN=... node src/cli/state.ts --json
node src/cli/state.ts --json --fixture test/fixtures --now 2026-10-02T12:00:00Z
```

The live command uses `GH_TOKEN`, else `GITHUB_TOKEN`; it needs the same read
permissions as the page. Project status uses a read-only GraphQL query sent
via POST; other sources use GET. Fixture mode never contacts GitHub. Source
failures produce a partial snapshot; invalid arguments or a missing token
exit nonzero. Run the source entrypoint directly: there is no npm `state`
script because `package.json` is protected for this change.

The existing **Changes**, **By priority** (including themes), **Usage**, and
ops detail remain below and start collapsed. Section choices are remembered.
`q`, `d`, `n`, `t`, `s` jump to Decisions, Agents, Changes, By priority, Usage;
`j`/`k`/`o` walk visible rows.

**Filters** in By priority narrow the queue by the organization an
entry targets and by priority, with each chip's count. The target is the
board's Org field, else a tracker issue's `target:<org>` label, else the
owner of the issue or PR (a tracker issue with neither has no org); a
forge PR counts as its upstream's. Two
presets split the queue in one click: **Composefs** is upstream work
(every organization but cgwalters-bot and cgwalters-forge), **Our
infra** is the bot's own harness. The filter is in the URL (`#composefs`,
`#infra+P0`, `#org:bootc-dev`) and remembered per browser, so `#` and
`u` come back to it.

**Themes and verdicts**, under By priority, are the whole board, not
only what waits on you: every item that isn't Done, read live
with the board's Theme, Verdict and Verdict target fields (looked up
by name; a board without them still loads, and the view says which
are missing). First the P0 lane, every open P0 item; then one
collapsible group per Theme, with its item count and a bar of its
verdicts (keep, merge into another item, park, close), and last the
items with no Theme, the untriaged bucket. Each item shows its
priority, status and verdict chip, and for merge and close the
target it points at; an item that is in the queue opens there. The
verdict chips above filter every group.

**Merged PRs**, in Changes, are recently merged PRs in the bot
(cgwalters-bot/homegit), its runner (cgwalters-devspace-sandbox, both
copies), agentic-job, agent-board and this app, newest first, with the first paragraph of each
description. Harness changes stand out: PRs labeled `harness`, or
touching `agent.yml`, `bot-harness` or a `harness/` tree.

**Board changes**, in Changes, are the
items that changed since you last pressed "Mark all seen", newest first
and grouped by day, with a chip per change (new, ↑/↓ priority, a
Status transition, Done, gone from the board, a Lead claimed or
released) and an optional P0/P1-only filter. GitHub keeps no history of
project fields, so the app keeps its own: a snapshot of each item's
Status, Priority, Lead and News in this browser's localStorage (the
board is public; the snapshot holds nothing else), diffed against the
whole board as read now (a Done item leaving the board is not news). The first visit only takes the snapshot.
**News** is a board field the coordinator sets to one dated line when
something notable happens to an item (`bot-board set --news` in
homegit); a new line shows highlighted under the item.

**The "Ask anything" box** atop the page files a note onto the board
(below). Its `#chat` slot is where a future coordinator chat view attaches (`chat.ts`).

Devspaces are the live runs of `devspace.yml` in
bootc-dev/cgwalters-devspace-sandbox, each with its tailnet host, cores,
uptime and time left (exact when the run's title carries its duration,
as in "Devspace NAME (16c, 120m)"; for older runs only bounded by the
longest, 4 hours), plus the last 24 hours: how many, their
core-hours per hour, and how they ended; cancelled is how `bot-devspace
stop` ends one, so it counts as stopped, not failed. **Local agents** are
the workers the coordinator runs on its own machine, which the browser
can't see: the coordinator publishes them with `bot-heartbeat publish`
(homegit) to one comment on cgwalters-forge/tracker#176, which the pane
reads with an ETag and lists with their item links, devspaces and
elapsed time, warning when the heartbeat is more than 15 minutes old
(and past the wake time it gave). **Usage** is the equivalent of
Claude Code's `/usage` there: a bar per plan window (5-hour and 7-day)
with its percent used and reset time, as the coordinator's status line
last reported them, the tokens that machine's transcripts spent in
each, and the top consumers (workers and the coordinator) by tokens.
It is private: `bot-heartbeat publish` writes it to one comment on
cgwalters-forge/bot-ops#1, a private repository, which the pane reads
with your token; nothing of it is in the build or the public heartbeat,
and a token that can't read that repository just gets a note saying
so. Below that are the
runs of `agent.yml` once that workflow exists there, the board's In
Progress items split like the Composefs and Our infra presets, and the
bot's recent public activity. The runner repo
is outside cgwalters-forge, so a fine-grained token scoped to it can't
read the devspaces; a classic token can.

The **capture bar** under the header, shown to cgwalters only, puts a
note on the board for the bot: clicking or focusing it, or `b` from any
view, expands an in-place composer. Ctrl/Cmd+Enter (or **File**) files it as an issue in
cgwalters-forge/tracker labelled `needs-triage`, added to the Workstream
board. A pasted GitHub link goes into the body and, with no title typed,
suggests one (`owner/repo#N: its title`). The label is what the bot acts
on: homegit's bot-notify wakes the coordinator for each of his open
issues carrying it, and the bot sets its board fields, turns it into
work or a question on the issue, and removes the label. So a board add
the token isn't allowed to make (it needs the `project` scope, or the
organization's Projects permission on a fine-grained token) leaves the
issue filed, with a note saying so (the bot adds it when it triages).
The title wraps and grows on narrow screens but remains a single-line
issue title; the multiline body accepts Markdown. **Note** retains its
existing disclosure semantics: it toggles the extra fields, not a filing
mode. Optional Priority (P0/P1/P2) sets the board item's actual Priority
field after it is added, resolving the field and option IDs by name.
Priority and Repo (`owner/repo`) also remain as `Priority:` and `Repo:`
body lines for the bot to triage. If setting Priority fails, the issue
stays filed on the board and the app explains how to check or set it there.
The label choices include `dispatch`, `escalate`, and cached tracker labels;
`dispatch` requires Repo. Repo suggestions remember the ten most recently
filed repos in this browser. An Epic is an open tracker issue labelled
`epic`; filing attaches the new issue as its sub-issue. A failed attachment
or board add keeps the filed issue link and explains the follow-up, rather
than inviting a duplicate filing. Filing also requests a queue refresh.
If creation's response is lost, the draft stays but retry is disabled:
check the tracker before reloading to retry, since the issue may exist.
Esc collapses the composer without losing text. An unsent draft is kept in
localStorage across tabs/reloads; signing out drops it.

Keys: `j`/`k` move, `o` opens, `u` goes back, `r` reloads, `t` triage, `q` decisions, `n` news, `d` ops, `b` capture; in a PR,
`n`/`p` step through files and `j`/`k` through hunks, `v` marks a file
viewed, `x` folds one, `s` switches unified and split, `[`/`]` step
through the commits, `g` starts (or leaves) the guided review, whose
hotspots `n`/`p` then walk, `c` comments on the focused line (or jumps
to the review text), `a` approves (after a confirmation); `?` lists
them. Your text never goes out with a line the bot would read as a
command (`/promote`, `/draft`, `/ready`).

On a narrow screen (a phone) the header's buttons fold into a ⋯ menu
(with who is signed in and the API budget), the capture bar into a
"+ File" button and the filter chips into one "Filters (active: …)"
button, and the summary line is hidden, so the first entry shows near
the top; the key hints are hidden on touch screens.

The board is polled every 30 seconds with ETags while the tab is
visible, the forge's PR search every minute, and a PR's reviews only
when it changed. With "remember" ticked at sign-in, responses are also
kept in IndexedDB (for your login only, roughly 50 MB at most, and
entries unconfirmed for 7 days are dropped at the next load),
so a reload shows the queue, a PR, the news or ops at once, marked "cached ·
N min ago" until GitHub confirms or replaces it. Signing out, or
GitHub rejecting the token at any time, deletes that cache; without
"remember" it lives in memory only.

When the header's time isn't moving, it says why next to it: "paused:
tab hidden", "slowed: rate limit low", "paused: rate limit until
14:05", "waiting on GitHub for 45 s". A request GitHub hasn't answered
in a minute fails, and a poll still running after two minutes is given
up on ("stalled"), so a connection that died silently never stops the
polling. Over the queue's cached copy it always says why, "refreshing…"
while the poll runs. A phone suspends a page in the background without
running its timers, so showing, restoring or focusing the page gives up
on a poll (and the reads) from before that and, if the data is older
than the poll interval, polls at once.

The app contains no data: everything is fetched in your browser with your
token, from `api.github.com` only.

## The queue on the command line

`review-queue` prints the same ranked, filtered queue for scripts and
agents, read-only:

```sh
npm ci && npm run build
npx review-queue --text                    # everything, for a human
npx review-queue --json --filter composefs # upstream work, as JSON
npx review-queue --filter composefs+P0     # the app's filter tokens; a bare P0 is all+P0
npx review-queue --filter org:composefs    # one organization
```

As in the app, `composefs` is all upstream work (every organization but
cgwalters-bot and cgwalters-forge), `infra` is those two; to see one
organization, use `org:NAME`.

Without `--json` or `--text`, it prints text on a terminal and JSON
otherwise. The JSON is the documented `review-queue/v1` schema
([docs/queue-json.md](docs/queue-json.md)): each entry has its kind,
priority, target org, GitHub and app URLs, its nested asks, and a
suggested `action` (`review`, `answer`, `rerun`, `read`, `wait`, ...).
It authenticates with `$GH_TOKEN`, else `$GITHUB_TOKEN`, else `gh auth
token --hostname github.com`; the token needs `read:project` for the board. It only sends GET
requests, so it never answers, reviews or reruns anything: the app does
that.

## Development

Builds and tests need Node.js 22.18 or later (TypeScript runs directly
through Node's type stripping):

```sh
npm ci
npm run check    # tsc, the unit tests, and a build into dist/
npm run dev      # serves http://127.0.0.1:8787/
```

## Hosting and sign-in

The app is published on GitHub Pages at
<https://cgwalters-forge.github.io/review/> by the `pages` workflow, on
every push to main. Until the sign-in relay exists (see "Hosting v0" in
[docs/design.md](docs/design.md)), you sign in by pasting a personal
access token. It stays in your browser (sessionStorage, or localStorage
if you tick "remember") and is sent only to `api.github.com`. The sign-in
page lists the scopes a token needs:

- a short-lived classic token with `public_repo` and `read:project`
  covers everything (`repo` instead, to see private repositories);
- a fine-grained token acts on one resource owner only: owned by
  cgwalters-forge, with Pull requests and Issues read and write, it
  reviews forge PRs and answers questions in the tracker; Make it mine
  also needs Contents read and write.

Make it mine needs no scope beyond these for a classic token
(`public_repo` covers the Git Data API and the ref update on public
forks), except for a PR that changes `.github/workflows`: GitHub guards
pushes of workflow changes with the `workflow` scope (Workflows: write),
so for such a PR the app asks for it up front (a classic token lacking
it gets no form; a fine-grained one gets a warning, since its
permissions aren't reported).

The answers and reviews it posts are real, so test against throwaway
items.
