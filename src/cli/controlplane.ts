// control-plane: the app's state on the command line, for the controller.
// The read commands use the app's loaders and derivations: the pass's
// published holds snapshot (Home's Act now, Live agents and capacity,
// Status's repository board) and review-queue's queue. Each prints one
// JSON document whose order is the publication's, with links.
// Read-only: the client refuses anything but GET.

import { GitHub, GitHubError } from "../github/api.ts";
import { actNowRows, mergeRefusal } from "../github/actnow.ts";
import { type Holds, loadPassPublications } from "../github/holds.ts";
import { askUrl } from "../github/inbox.ts";
import { redactAddresses, stale } from "../github/passes.ts";
import type { PassView } from "../github/passview.ts";
import { type Io, readOnly, run as runQueue } from "./queue.ts";

export const PROG = "control-plane";
const SCHEMA = "control-plane/v1";
const REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/;

export const USAGE = `Usage: ${PROG} COMMAND [ARGS]

Read the control plane's state as the review app shows it, as JSON.

  status               live agents, capacity (pools, WIP) and the last passes
                       with their starts and no-start reasons
  act-now              the pass's Act now shortlist, as Home shows it
  queue [ARGS]         the review queue; ARGS as for review-queue (--help)
  repo OWNER/REPO      the pass's dispatchable work, live runs and asks on a repository
  changes --since TIME passes, starts and new asks since an ISO time
  -h, --help           this text

The token comes from $GH_TOKEN, else $GITHUB_TOKEN, else
\`gh auth token --hostname github.com\`. Only GET requests are sent.
`;

class UsageError extends Error {
  override name = "UsageError";
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

const itemUrl = (item: string) => `https://github.com/${item.replace("#", "/issues/")}`;

const runUrl = (r: { repository: string; id: number }) => `https://github.com/${r.repository}/actions/runs/${r.id}`;

/** The snapshot's part a command needs, or an error naming why it can't be used. */
function part<T>(value: T | string | undefined, what: string): T {
  if (value === undefined) throw new Error(`the pass's snapshot has no ${what}`);
  if (typeof value === "string") throw new Error(`the pass's ${what} can't be used: ${value}`);
  return value;
}

async function loadHolds(gh: GitHub): Promise<Holds> {
  const { holds, uncertain } = await loadPassPublications(gh);
  if (!holds) throw new Error(uncertain ?? "the pass has published no hold snapshot");
  return holds;
}

type Pass = PassView["passes"][number];

function passJson(p: Pass) {
  return {
    at: p.at,
    result: p.result,
    sections: p.sections.map((s) => ({ name: s.name, result: s.result, error: s.error === null ? null : redactAddresses(s.error) })),
    started: p.started.map((s) => ({ item: s.item, kind: s.kind, pool: s.pool, url: itemUrl(s.item), run: runUrl(s.run) })),
    noStart: p.reasons.map((r) => ({ item: r.item, kind: r.kind, reason: redactAddresses(r.reason), until: r.until })),
    omitted: p.omitted,
  };
}

function flightJson(f: PassView["in_flight"][number]) {
  return f.state === "running"
    ? { state: f.state, item: f.item, kind: f.kind, pool: f.pool, startedAt: f.started_at ?? null, url: itemUrl(f.item), run: runUrl(f.run) }
    : { state: f.state, item: `${f.repository}#${f.number}`, url: `https://github.com/${f.repository}/pull/${f.number}` };
}

/** What every document says of the publication it read. */
function observed(view: PassView, now: number) {
  return { observedAt: view.observed_at, stale: stale(view.observed_at, now), complete: view.complete, omitted: view.omitted };
}

function status(h: Holds, now: number) {
  const view = part(h.passView, "pass view");
  return {
    ...observed(view, now),
    wip: h.wip ?? null,
    live: view.in_flight.map(flightJson),
    pools: view.pools.map((p) => ({ name: p.name, usedPercent: p.used_percent, allowedPercent: p.allowed_percent, resetsAt: p.resets_at, ready: p.ready, underPace: p.under_pace })),
    passes: view.passes.map(passJson),
  };
}

function actNow(h: Holds, now: number) {
  const list = part(h.needsYou, "needs-you list");
  // As Home reads it: a list just confirmed; actNowRows applies its own age bound.
  const rows = actNowRows({ list, asks: list.items, unavailable: false, checkedAt: now }, now);
  return {
    validatedAt: list.validatedAt,
    complete: list.complete,
    rows: rows.map(({ ask: a, unblocks }) => ({
      key: a.key, item: a.item, kind: a.kind, priority: a.priority, waitingSince: a.waitingSince, ask: a.ask, unblocks,
      action: a.action, url: askUrl(a.action), mergeRefusal: mergeRefusal(a) ?? null,
    })),
  };
}

function repo(h: Holds, name: string, now: number) {
  const work = part(h.dispatchableWork, "dispatchable work");
  const lower = name.toLowerCase();
  const [repository, entry] = Object.entries(work.repositories).find(([r]) => r.toLowerCase() === lower) ?? [name, undefined];
  const view = typeof h.passView === "object" ? h.passView : undefined;
  const list = typeof h.needsYou === "object" ? h.needsYou : undefined;
  const on = (item: string) => item.toLowerCase().startsWith(`${lower}#`);
  return {
    repository,
    // Absent from the publication: the pass has no record of it, not proof of no work.
    work: entry ? { ...entry, items: entry.items.map((i) => ({ ...i, url: itemUrl(i.item) })) } : null,
    live: view ? view.in_flight.map(flightJson).filter((f) => on(f.item)) : null,
    asks: list ? list.items.filter((a) => a.action.repository.toLowerCase() === lower).map((a) => ({ key: a.key, kind: a.kind, waitingSince: a.waitingSince, ask: a.ask, url: askUrl(a.action) })) : null,
    ...(view ? { pass: observed(view, now) } : {}),
  };
}

function changes(h: Holds, since: number, now: number) {
  const view = part(h.passView, "pass view");
  const list = typeof h.needsYou === "object" ? h.needsYou : undefined;
  const after = (iso: string) => Date.parse(iso) > since;
  return {
    since: new Date(since).toISOString(),
    ...observed(view, now),
    passes: view.passes.filter((p) => after(p.at)).map(passJson),
    // The pass view keeps only its last few passes: older ones are unknown here.
    passesCovered: view.passes.length > 0 && view.passes.some((p) => !after(p.at)),
    asks: list ? list.items.filter((a) => after(a.waitingSince)).map((a) => ({ key: a.key, kind: a.kind, waitingSince: a.waitingSince, ask: a.ask, url: askUrl(a.action) })) : null,
    ...(list ? { asksChangedAt: list.changedAt } : {}),
  };
}

/** The positional arguments a command takes, refusing anything else. */
function parse(command: string, args: readonly string[]): { repo?: string; since?: number } {
  if (command === "repo") {
    if (args.length !== 1 || !REPO_RE.test(args[0]!)) throw new UsageError("repo needs one OWNER/REPO");
    return { repo: args[0]! };
  }
  if (command === "changes") {
    const [flag, value, ...rest] = args[0]?.startsWith("--since=") ? ["--since", args[0].slice("--since=".length), ...args.slice(1)] : args;
    const since = Date.parse(value ?? "");
    if (flag !== "--since" || rest.length || !Number.isFinite(since)) throw new UsageError("changes needs --since ISO_TIME");
    return { since };
  }
  if (args.length) throw new UsageError(`${command} takes no arguments`);
  return {};
}

const COMMANDS = ["status", "act-now", "repo", "changes"] as const;

/** Run the CLI; the exit status: 0, 1 on failure, 2 on a usage error. */
export async function run(argv: readonly string[], io: Io): Promise<number> {
  const [command, ...args] = argv;
  if (command === "queue") return runQueue(args, io);
  if (command === "-h" || command === "--help") {
    io.stdout(USAGE);
    return 0;
  }
  let opts: ReturnType<typeof parse>;
  try {
    if (!COMMANDS.includes(command as (typeof COMMANDS)[number])) throw new UsageError(command ? `unknown command ${JSON.stringify(command)}` : "a command is needed");
    opts = parse(command!, args);
  } catch (e) {
    io.stderr(`${PROG}: ${message(e)}\n${USAGE}`);
    return 2;
  }
  try {
    const now = io.now().getTime();
    const holds = await loadHolds(new GitHub(io.token, readOnly(io.fetch)));
    const body = command === "status" ? status(holds, now)
      : command === "act-now" ? actNow(holds, now)
        : command === "repo" ? repo(holds, opts.repo!, now)
          : changes(holds, opts.since!, now);
    io.stdout(`${JSON.stringify({ schema: SCHEMA, command, generatedAt: new Date(now).toISOString(), ...body }, null, 2)}\n`);
    return 0;
  } catch (e) {
    const text = e instanceof GitHubError && e.status === 401 ? "GitHub refused the token (HTTP 401); check $GH_TOKEN/$GITHUB_TOKEN, or `gh auth status`" : message(e);
    io.stderr(`${PROG}: ${text}\n`);
    return 1;
  }
}
