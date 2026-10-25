// agent-board's operator-action contract; see docs/operator-actions.md. No proposal
// supplies an API path, credential, trusted writer, repository allowlist or project ID.
import { GitHubError, type GitHub } from "./api.ts";
import { missingScopes } from "./auth.ts";
import rawConfig from "./action-config.json" with { type: "json" };
import { matchesActionSchema } from "./actionschema.ts";

const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/;
const OWNER = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,38}$/;
const LOGIN = /^[A-Za-z0-9-]+(?:\[bot\])?$/;
const PROJECT = /^https:\/\/github\.com\/(orgs|users)\/[A-Za-z0-9_][A-Za-z0-9_-]{0,38}\/projects\/[1-9][0-9]{0,14}$/;
export const ACTION_SCHEMA = "agent-board/operator-action/v1";

/**
 * `project` is the one project URL proposals may write to, or empty to refuse project-field actions;
 * `org` likewise is the one organisation whose variables and rulesets they may change.
 */
export interface ActionConfig { operator: string; planner: string; tracker: string; repositories: string[]; project: string; org: string }

export function actionConfig(value: unknown): ActionConfig | undefined {
  const c = value as ActionConfig;
  if (c && c.operator === "" && c.planner === "" && c.tracker === "" && c.project === "" && c.org === "" && Array.isArray(c.repositories) && !c.repositories.length) return undefined;
  if (!c || typeof c.operator !== "string" || !LOGIN.test(c.operator) || typeof c.planner !== "string" || !LOGIN.test(c.planner) || typeof c.tracker !== "string" || !REPO.test(c.tracker)
    || !Array.isArray(c.repositories) || !c.repositories.length || c.repositories.length > 100
    || c.repositories.some((r) => typeof r !== "string" || !REPO.test(r))
    || typeof c.project !== "string" || (c.project !== "" && !PROJECT.test(c.project))
    || typeof c.org !== "string" || (c.org !== "" && !OWNER.test(c.org))) throw new Error("Invalid operator action configuration");
  return c;
}

export const ACTION_CONFIG = actionConfig(rawConfig);
// agent-board's names. Actions on an issue or PR carry no timestamps or prior
// values: staleness is judged against live state shown to the operator (see plan()).
interface Target { repo: string; number: number }
type ItemAction = Target & (
  | { type: "close_issue"; reason: string }
  | { type: "reopen_issue" }
  | { type: "add_label" | "remove_label"; label: string }
  | { type: "approve_pull_request"; head_sha: string }
  | { type: "merge_pull_request"; head_sha: string; method: "merge" | "squash" | "rebase" }
  | { type: "set_project_field"; project: string; field: "Priority" | "Status"; value: string }
  | { type: "add_sub_issue"; parent_repo: string; parent_number: number }
  | { type: "move_sub_issue"; parent_repo: string; parent_number: number; previous_parent_repo: string; previous_parent_number: number }
);
/** The org kinds overwrite state that was the proposal's input, so they carry what the proposer saw. */
export interface OrgVariable { type: "set_org_variable"; org: string; name: string; value: string; visibility: "all" | "selected"; repositories?: string[]; expected_current: string | null }
export interface OrgRuleset { type: "apply_org_ruleset"; org: string; source: { repo: string; path: string; sha: string }; ruleset_name: string; expected_current_sha256: string | null }
export type Action = ItemAction | OrgVariable | OrgRuleset;
export interface Proposal { schema: typeof ACTION_SCHEMA; title: string; why: string; actions: Action[] }

const ref = (repo: string, number: number): string => `${repo.toLowerCase()}#${number}`;
/** GitHub's 48 KB Actions variable limit, in UTF-8 bytes; the schema can only count characters. */
export const VARIABLE_LIMIT = 49152;
const utf8 = (s: string) => new TextEncoder().encode(s);

export function validateProposal(value: unknown, c: ActionConfig): Proposal {
  if (!matchesActionSchema(value)) throw new Error("Proposal does not match the operator action schema");
  const p = value as Proposal;
  const allowed = (repo: string): boolean => c.repositories.some((r) => r.toLowerCase() === repo.toLowerCase());
  const org = (o: string): void => { if (!c.org || o.toLowerCase() !== c.org.toLowerCase()) throw new Error(`Organisation ${o} is not allowed`); };
  for (const a of p.actions) {
    if ("repo" in a && !allowed(a.repo)) throw new Error(`Repository ${a.repo} is not allowed`);
    switch (a.type) {
      case "close_issue": if (/^\s*\/(?:promote|draft|ready)\b/im.test(a.reason)) throw new Error("Invalid close reason"); break;
      // "." and ".." survive encodeURIComponent and URL parsing collapses them, so
      // DELETE …/labels/. would reach the remove-all-labels endpoint.
      case "add_label": case "remove_label": if (/^\.{1,2}$/.test(a.label)) throw new Error("Invalid label"); break;
      // Repository scope is not project write authority; only the configured project is.
      case "set_project_field": if (!c.project || a.project.toLowerCase() !== c.project.toLowerCase()) throw new Error("Project is not allowed"); break;
      case "add_sub_issue": case "move_sub_issue":
        if (!allowed(a.parent_repo) || (a.type === "move_sub_issue" && !allowed(a.previous_parent_repo))) throw new Error("Parent repository is not allowed");
        if (ref(a.parent_repo, a.parent_number) === ref(a.repo, a.number)) throw new Error("An issue cannot be its own parent");
        break;
      case "set_org_variable": {
        org(a.org);
        const seen = new Set<string>();
        for (const r of a.repositories ?? []) {
          if (!allowed(r) || r.split("/")[0]!.toLowerCase() !== a.org.toLowerCase()) throw new Error(`Repository ${r} is not allowed for ${a.org}`);
          if (seen.has(r.toLowerCase())) throw new Error(`Repository ${r} is not allowed twice`);
          seen.add(r.toLowerCase());
        }
        if ([a.value, a.expected_current].some((v) => v !== null && utf8(v).length > VARIABLE_LIMIT)) throw new Error(`Variable values are limited to ${VARIABLE_LIMIT} UTF-8 bytes`);
        break;
      }
      case "apply_org_ruleset":
        org(a.org);
        if (!allowed(a.source.repo)) throw new Error(`Repository ${a.source.repo} is not allowed`);
        break;
    }
  }
  return p;
}

export interface Comment { id: string; databaseId: number; body: string; updatedAt: string; author: { login: string } | null; editor: { login: string } | null; lastEditedAt: string | null }
export interface Offered { issue: number; comment: Comment; proposal: Proposal }
export interface Discovery { offers: Offered[]; warnings: string[] }
interface Connection { nodes: Comment[]; pageInfo: { hasNextPage: boolean } }

function trusted(comment: Comment, c: ActionConfig): boolean {
  const writers = [c.operator.toLowerCase(), c.planner.toLowerCase()];
  return !!comment.author && writers.includes(comment.author.login.toLowerCase())
    && (!comment.lastEditedAt || !!comment.editor && writers.includes(comment.editor.login.toLowerCase()));
}

async function graphql<T>(gh: GitHub, query: string, variables: Record<string, unknown>): Promise<T> {
  const r = await gh.send<{ data?: T; errors?: unknown[] }>("POST", "/graphql", { query, variables });
  if (r.errors?.length || !r.data) throw new Error("GitHub could not confirm operator action data");
  return r.data;
}

export async function comments(gh: GitHub, c: ActionConfig, issue: number): Promise<Comment[]> {
  const [owner, name] = c.tracker.split("/");
  const r = await graphql<{ repository: { issue: { state: string; comments: Connection } | null } }>(gh,
    `query($owner:String!,$name:String!,$issue:Int!){repository(owner:$owner,name:$name){issue(number:$issue){state comments(first:100){nodes{id databaseId body updatedAt author{login} editor{login} lastEditedAt} pageInfo{hasNextPage}}}}}`, { owner, name, issue });
  if (!r.repository?.issue || r.repository.issue.state !== "OPEN" || r.repository.issue.comments.pageInfo.hasNextPage) throw new Error("Proposal issue is closed, missing, or has more than 100 comments");
  return r.repository.issue.comments.nodes;
}

export function marker(o: Offered): string { return `<!-- agent-board-action-executed: ${o.comment.databaseId}@${o.comment.updatedAt} -->`; }

function recorded(all: Comment[], o: Offered, c: ActionConfig): boolean {
  return all.some((v) => trusted(v, c) && v.body.split("\n")[0] === marker(o));
}

export function proposals(all: Comment[], issue: number, c: ActionConfig): Offered[] {
  const out: Offered[] = [];
  for (const comment of all) {
    if (!trusted(comment, c)) continue;
    const blocks = [...comment.body.matchAll(/^```agent-board-action\r?\n([\s\S]*?)^```[ \t]*\r?$/gm)];
    if (!blocks.length) continue;
    if (blocks.length !== 1 || comment.body.length > 65536) throw new Error("Ambiguous or oversized operator action comment");
    const proposal = validateProposal(JSON.parse(blocks[0]![1]!), c);
    const o = { issue, comment, proposal };
    if (!recorded(all, o, c)) out.push(o);
  }
  return out;
}

export async function loadProposals(gh: GitHub, c: ActionConfig): Promise<Discovery> {
  // Deliberately manual and bounded: no polling fan-out over tracker history.
  const issues = await gh.send<{ number: number; pull_request?: unknown }[]>("GET", `/repos/${c.tracker}/issues?state=open&sort=updated&direction=desc&per_page=20`);
  const out: Offered[] = [];
  const warnings: string[] = [];
  for (const issue of issues) if (!issue.pull_request) {
    try { out.push(...proposals(await comments(gh, c, issue.number), issue.number, c)); }
    catch (e) { warnings.push(`${c.tracker}#${issue.number}: ${String(e)}`); }
  }
  return { offers: out, warnings };
}

interface Issue { id: number; node_id: string; title: string; state: string; pull_request?: unknown; labels: { name: string }[]; parent_issue_url?: string | null }
/** An org variable as read: its selected repositories are lower case and sorted, null unless selected. */
export interface Variable { value: string; visibility: string; repositories: string[] | null }
/** The live fact an action depends on: issue state, label membership, PR state and head, parent, field value, variable, or ruleset digest. */
export type Fact = string | boolean | null | Variable;
/** An org action's exact request; for a ruleset, also the normalised live ruleset ("(none)") and source body, indented, to diff. */
export interface Mutation { method: string; path: string; body: unknown; diff?: { live: string; source: string } }
/** `next` is the fact an org action leaves, which the proposal alone does not give. */
interface Observed { title: string; fact: Fact; next?: Fact; mutation?: Mutation; apply(): Promise<void> }

const RULESET_FIELDS = ["bypass_actors", "conditions", "enforcement", "name", "rules", "target"];
export const RULESET_SOURCE_LIMIT = 64 * 1024;
/** More rulesets than this many pages of 100 are refused rather than half-read. */
const RULESET_PAGES = 10;
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Strings serde_json, and so agent-board, cannot hold. */
const LONE_SURROGATE = /\p{Surrogate}/u;
const text = (s: string): string => {
  if (LONE_SURROGATE.test(s)) throw new Error("Unsupported string: a lone UTF-16 surrogate");
  return JSON.stringify(s);
};

/**
 * agent-board's canonical JSON: object keys sorted by UTF-16 code unit (the
 * default sort), arrays in order, JSON.stringify escaping, and only safe
 * integers and well-formed strings. Compact, or indented by `indent` for display.
 */
function canonicalJson(v: unknown, indent = "", pad = ""): string {
  if (typeof v === "number" && !Number.isSafeInteger(v)) throw new Error(`Unsupported number ${v}: expected a safe integer`);
  if (typeof v === "string") return text(v);
  if (!v || typeof v !== "object") return JSON.stringify(v);
  const o = v as Record<string, unknown>;
  const inner = pad + indent;
  const items = Array.isArray(v) ? v.map((x) => canonicalJson(x, indent, inner))
    : Object.keys(o).sort().map((k) => `${text(k)}:${indent ? " " : ""}${canonicalJson(o[k], indent, inner)}`);
  const [open, close] = Array.isArray(v) ? "[]" : "{}";
  const nl = indent ? "\n" : "";
  return items.length ? `${open}${nl}${inner}${items.join(`,${nl}${inner}`)}${nl}${pad}${close}` : `${open}${close}`;
}

/** A ruleset's writable fields as canonical JSON: the body a create or update sends, and what its digest covers. */
export function normalizeRuleset(ruleset: unknown, indent = ""): string {
  if (!isObject(ruleset)) throw new Error("A ruleset must be an object");
  return canonicalJson(Object.fromEntries(Object.entries(ruleset).filter(([k]) => RULESET_FIELDS.includes(k))), indent);
}

async function sha256(text: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** What `expected_current_sha256` holds. */
export async function rulesetDigest(ruleset: unknown): Promise<string> { return sha256(normalizeRuleset(ruleset)); }

/**
 * agent-board's check_ruleset_source: the file is the writable body only,
 * named as proposed, never `disabled`, and adds no bypass actor the live
 * ruleset (undefined when creating) lacks. Here also, an update states every
 * writable field the live ruleset has. Returns the normalised body.
 */
export function checkRulesetSource(text: string, name: string, live: unknown): string {
  if (utf8(text).length > RULESET_SOURCE_LIMIT) throw new Error(`Ruleset source exceeds ${RULESET_SOURCE_LIMIT} bytes`);
  let v: unknown;
  try { v = JSON.parse(text); } catch { throw new Error("Ruleset source is not JSON"); }
  if (!isObject(v) || !Object.keys(v).every((k) => RULESET_FIELDS.includes(k)) || !["name", "target", "enforcement", "rules"].every((k) => Object.hasOwn(v, k))) throw new Error("Ruleset source must be exactly a ruleset's writable body");
  if (v.name !== name) throw new Error(`Ruleset source name does not match ${JSON.stringify(name)}`);
  if (!["branch", "tag", "push"].includes(v.target as string)) throw new Error("Unsupported ruleset target");
  // `disabled` would switch enforcement off through a reviewed-looking change.
  if (!["evaluate", "active"].includes(v.enforcement as string)) throw new Error("Ruleset enforcement must be evaluate or active");
  if (!Array.isArray(v.rules) || !v.rules.every((r) => isObject(r) && typeof r.type === "string")) throw new Error("Ruleset rules must be objects with a string type");
  if (Object.hasOwn(v, "conditions") && !isObject(v.conditions)) throw new Error("Ruleset conditions must be an object");
  // An update would otherwise show a removal the diff promises and GitHub never performs.
  const kept = isObject(live) ? RULESET_FIELDS.filter((k) => Object.hasOwn(live, k) && !Object.hasOwn(v, k)) : [];
  if (kept.length) throw new Error(`Ruleset source must state every field the live ruleset has (GitHub keeps omitted fields): ${kept.join(", ")}`);
  const actors = (r: Record<string, unknown>): string[] => {
    if (!Object.hasOwn(r, "bypass_actors")) return [];
    if (!Array.isArray(r.bypass_actors)) throw new Error("bypass_actors must be an array");
    return r.bypass_actors.map((a) => canonicalJson(a));
  };
  const allowed = isObject(live) ? actors(live) : [];
  const mine = actors(v);
  for (const [i, actor] of mine.entries()) {
    if (!allowed.includes(actor)) throw new Error(`Ruleset source adds bypass actor ${actor}`);
    if (mine.indexOf(actor) !== i) throw new Error("Ruleset source repeats a bypass actor");
  }
  return normalizeRuleset(v);
}

/** Base64 file content as strict UTF-8; a byte-order mark is kept, so JSON.parse refuses it as agent-board does. */
function decode(content: string): string {
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Uint8Array.from(atob(content.replace(/\n/g, "")), (ch) => ch.charCodeAt(0))); }
  catch { throw new Error("Ruleset source is not base64-encoded UTF-8"); }
}

/** The one org ruleset named exactly `name`, read by ID, or undefined; names are matched across a bounded list. */
async function liveRuleset(gh: GitHub, org: string, name: string): Promise<{ id: number; ruleset: Record<string, unknown> } | undefined> {
  const ids: number[] = [];
  for (let page = 1; ; page++) {
    const list = await gh.send<{ id: number; name: string }[]>("GET", `/orgs/${org}/rulesets?per_page=100&targets=branch,tag,push&page=${page}`);
    ids.push(...list.filter((r) => r.name === name).map((r) => r.id));
    if (list.length < 100) break;
    if (page === RULESET_PAGES) throw new Error(`${org} has more than ${RULESET_PAGES * 100} rulesets`);
  }
  if (ids.length > 1) throw new Error(`${org} has ${ids.length} rulesets named ${JSON.stringify(name)}`);
  const id = ids[0];
  if (id === undefined) return undefined;
  if (!Number.isSafeInteger(id) || id < 1) throw new Error("Unrecognised ruleset ID");
  const ruleset = await gh.send<Record<string, unknown>>("GET", `/orgs/${org}/rulesets/${id}`);
  if (ruleset.name !== name) throw new Error(`Ruleset ${id} is no longer named ${JSON.stringify(name)}`);
  return { id, ruleset };
}

const lowerSorted = (names: string[]): string[] => names.map((n) => n.toLowerCase()).sort();
const ORG_SCOPE = [{ any: ["admin:org"], why: "organisation variables and rulesets" }];

async function issue(gh: GitHub, repo: string, number: number): Promise<Issue> {
  const i = await gh.send<Issue>("GET", `/repos/${repo}/issues/${number}`);
  // Labels apply to both; every other issue action must not land on a PR.
  if (i.pull_request) throw new Error(`${repo}#${number} is a pull request`);
  return i;
}

function parentOf(i: Issue): Fact {
  const m = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(i.parent_issue_url ?? "");
  if (i.parent_issue_url && !m) throw new Error("Unrecognised parent issue URL");
  return m ? ref(m[1]!, Number(m[2])) : null;
}

/** Reads the current fact for an action and binds its mutation to the live IDs just read. */
async function observe(gh: GitHub, c: ActionConfig, a: Action): Promise<Observed> {
  const send = async (method: string, url: string, body?: unknown): Promise<void> => { await gh.send(method, url, body); };
  // A classic token without it would fail only at the write; the rest of the site never needs it.
  if (!("repo" in a) && missingScopes(gh.scopes, ORG_SCOPE).length) throw new Error("Organisation actions: this token needs admin:org");
  switch (a.type) {
    case "set_org_variable": {
      const base = `/orgs/${a.org}/actions/variables`;
      const live = await gh.send<{ value: string; visibility: string }>("GET", `${base}/${a.name}`).catch((e: unknown) => {
        if (e instanceof GitHubError && e.status === 404) return null;
        throw e;
      });
      let fact: Variable | null = null;
      if (live) {
        let repositories: string[] | null = null;
        if (live.visibility === "selected") {
          const r = await gh.send<{ total_count: number; repositories: { full_name: string }[] }>("GET", `${base}/${a.name}/repositories?per_page=100`);
          if (r.total_count > r.repositories.length) throw new Error(`Variable ${a.name} has more than ${r.repositories.length} selected repositories`);
          repositories = lowerSorted(r.repositories.map((v) => v.full_name));
        }
        fact = { value: live.value, visibility: live.visibility, repositories };
      }
      // Repository IDs come from this read, never from the proposal; a renamed or transferred repository is refused.
      const ids: number[] = [];
      for (const r of a.repositories ?? []) {
        const repo = await gh.send<{ id: number; full_name: string }>("GET", `/repos/${r}`);
        if (repo.full_name.toLowerCase() !== r.toLowerCase()) throw new Error(`${r} is now ${repo.full_name}`);
        ids.push(repo.id);
      }
      const mutation = { method: live ? "PATCH" : "POST", path: live ? `${base}/${a.name}` : base,
        body: { name: a.name, value: a.value, visibility: a.visibility, ...(a.repositories ? { selected_repository_ids: ids } : {}) } };
      return { title: `Organisation variable ${a.name}`, fact, next: { value: a.value, visibility: a.visibility, repositories: a.repositories ? lowerSorted(a.repositories) : null },
        mutation, apply: () => send(mutation.method, mutation.path, mutation.body) };
    }
    case "apply_org_ruleset": {
      const { repo, path, sha } = a.source;
      const file = await gh.send<{ type?: string; encoding?: string; size?: number; content?: string }>("GET", `/repos/${repo}/contents/${path}?ref=${sha}`);
      if (file.type !== "file" || file.encoding !== "base64" || typeof file.content !== "string" || (file.size ?? Infinity) > RULESET_SOURCE_LIMIT) throw new Error(`${repo}/${path} at ${sha} is not a file of at most ${RULESET_SOURCE_LIMIT} bytes`);
      // Reviewed code only: a member can push an unreviewed branch to an allowlisted repository.
      const { default_branch: main, full_name } = await gh.send<{ default_branch: string; full_name: string }>("GET", `/repos/${repo}`);
      if (full_name.toLowerCase() !== repo.toLowerCase()) throw new Error(`${repo} is now ${full_name}`);
      const compare = await gh.send<{ status: string }>("GET", `/repos/${repo}/compare/${encodeURIComponent(main).replaceAll("%2F", "/")}...${sha}?per_page=1`);
      if (compare.status !== "behind" && compare.status !== "identical") throw new Error(`${repo}@${sha} is not on its default branch ${main}`);
      const live = await liveRuleset(gh, a.org, a.ruleset_name);
      const body = checkRulesetSource(decode(file.content), a.ruleset_name, live?.ruleset);
      const mutation: Mutation = { method: live ? "PUT" : "POST", path: live ? `/orgs/${a.org}/rulesets/${live.id}` : `/orgs/${a.org}/rulesets`, body: JSON.parse(body),
        diff: { live: live ? normalizeRuleset(live.ruleset, "  ") : "(none)", source: normalizeRuleset(JSON.parse(body), "  ") } };
      return { title: `Organisation ruleset ${a.ruleset_name}`, fact: live ? await rulesetDigest(live.ruleset) : null, next: await sha256(body),
        mutation, apply: () => send(mutation.method, mutation.path, mutation.body) };
    }
  }
  const path = `/repos/${a.repo}/issues/${a.number}`;
  switch (a.type) {
    case "approve_pull_request": case "merge_pull_request": {
      const prPath = `/repos/${a.repo}/pulls/${a.number}`;
      const pr = await gh.send<{ title: string; state: string; merged: boolean; draft: boolean; head: { sha: string } }>("GET", prPath);
      return { title: pr.title, fact: pr.merged ? "merged" : `${pr.state}${pr.draft ? " draft" : ""} ${pr.head.sha}`, apply: async () => {
        if (a.type === "approve_pull_request") await send("POST", `${prPath}/reviews`, { event: "APPROVE", commit_id: a.head_sha });
        else {
          const result = await gh.send<{ merged: boolean; message: string }>("PUT", `${prPath}/merge`, { sha: a.head_sha, merge_method: a.method });
          if (!result.merged) throw new Error(`Not merged: ${result.message}`);
        }
      } };
    }
    case "close_issue": case "reopen_issue": {
      const i = await issue(gh, a.repo, a.number);
      return { title: i.title, fact: i.state, apply: async () => {
        if (a.type === "close_issue") await send("POST", `${path}/comments`, { body: a.reason });
        await send("PATCH", path, { state: a.type === "close_issue" ? "closed" : "open" });
      } };
    }
    case "add_label": case "remove_label": {
      const i = await gh.send<Issue>("GET", path);
      return { title: i.title, fact: i.labels.some((l) => l.name.toLowerCase() === a.label.toLowerCase()),
        apply: () => a.type === "add_label" ? send("POST", `${path}/labels`, { labels: [a.label] }) : send("DELETE", `${path}/labels/${encodeURIComponent(a.label)}`) };
    }
    case "add_sub_issue": case "move_sub_issue": {
      const i = await issue(gh, a.repo, a.number);
      const parent = await issue(gh, a.parent_repo, a.parent_number);
      return { title: `${i.title} → ${parent.title}`, fact: parentOf(i), apply: () => send("POST", `/repos/${a.parent_repo}/issues/${a.parent_number}/sub_issues`, { sub_issue_id: i.id, replace_parent: a.type === "move_sub_issue" }) };
    }
    case "set_project_field": {
      if (!c.project || a.project.toLowerCase() !== c.project.toLowerCase()) throw new Error("Project is not allowed");
      const i = await gh.send<Issue>("GET", path);
      const items = `projectItems(first:100){nodes{id project{id url field(name:$field){... on ProjectV2SingleSelectField{id options{id name}}}} fieldValueByName(name:$field){... on ProjectV2ItemFieldSingleSelectValue{name}}} pageInfo{hasNextPage}}`;
      const data = await graphql<{ node: { projectItems: { nodes: { id: string; project: { id: string; url: string; field: { id?: string; options?: { id: string; name: string }[] } | null }; fieldValueByName: { name?: string } | null }[]; pageInfo: { hasNextPage: boolean } } } | null }>(gh,
        `query($issue:ID!,$field:String!){node(id:$issue){... on Issue{${items}} ... on PullRequest{${items}}}}`, { issue: i.node_id, field: a.field });
      const list = data.node?.projectItems;
      // Project, field, option and item IDs come from this read, never from the proposal.
      const item = list?.nodes.find((v) => v.project.url.toLowerCase() === c.project.toLowerCase());
      const field = item?.project.field;
      const option = field?.options?.find((v) => v.name === a.value);
      if (!list || list.pageInfo.hasNextPage || !item || !field?.id || !option) throw new Error("Project item, field or option is unavailable");
      return { title: i.title, fact: item.fieldValueByName?.name ?? null, apply: async () => {
        await graphql(gh, `mutation($project:ID!,$item:ID!,$field:ID!,$option:String!){updateProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field,value:{singleSelectOptionId:$option}}){projectV2Item{id}}}`, { project: item.project.id, item: item.id, field: field.id, option: option.id });
      } };
    }
  }
}

// Which fact an action reads; actions sharing a key in one proposal see earlier ones' effects.
function key(a: Action): string {
  switch (a.type) {
    case "set_org_variable": return `${a.org.toLowerCase()} variable ${a.name}`;
    case "apply_org_ruleset": return `${a.org.toLowerCase()} ruleset ${a.ruleset_name}`;
  }
  const t = ref(a.repo, a.number);
  switch (a.type) {
    case "close_issue": case "reopen_issue": return `${t} state`;
    case "add_label": case "remove_label": return `${t} label ${a.label.toLowerCase()}`;
    case "approve_pull_request": case "merge_pull_request": return `${t} pull`;
    case "add_sub_issue": case "move_sub_issue": return `${t} parent`;
    case "set_project_field": return `${t} ${a.project.toLowerCase()} ${a.field}`;
  }
}

const label = (a: Action): string => "repo" in a ? `${a.repo}#${a.number}` : a.type === "set_org_variable" ? `${a.org} variable ${a.name}` : `${a.org} ruleset ${JSON.stringify(a.ruleset_name)}`;

// Checks the action's precondition against the fact and returns the fact after it.
// A stale ruleset names the live digest: a member proposer cannot compute it.
function step(a: Action, fact: Fact, next: Fact | undefined): Fact {
  const want = (ok: boolean, expected: string): void => { if (!ok) throw new Error(`Stale ${label(a)}: expected ${expected}, found ${JSON.stringify(fact)}`); };
  switch (a.type) {
    case "set_org_variable": want(((fact as Variable | null)?.value ?? null) === a.expected_current, a.expected_current === null ? "unset" : JSON.stringify(a.expected_current)); return next!;
    case "apply_org_ruleset": want(fact === a.expected_current_sha256, a.expected_current_sha256 === null ? "no ruleset of that name" : `digest ${a.expected_current_sha256}`); return next!;
    case "close_issue": want(fact === "open", "open"); return "closed";
    case "reopen_issue": want(fact === "closed", "closed"); return "open";
    case "add_label": want(fact === false, `no ${a.label} label`); return true;
    case "remove_label": want(fact === true, `a ${a.label} label`); return false;
    case "approve_pull_request": want(fact === `open ${a.head_sha}`, `an open, non-draft PR at ${a.head_sha}`); return fact;
    case "merge_pull_request": want(fact === `open ${a.head_sha}`, `an open, non-draft PR at ${a.head_sha}`); return "merged";
    case "add_sub_issue": want(fact === null, "no parent"); return ref(a.parent_repo, a.parent_number);
    case "move_sub_issue": {
      const previous = ref(a.previous_parent_repo, a.previous_parent_number);
      want(fact === previous, `parent ${previous}`); return ref(a.parent_repo, a.parent_number);
    }
    case "set_project_field": return a.value;
  }
}

/** What the operator is shown, and what execution later requires to still hold. */
export interface Plan { states: string[]; expected: Fact[]; mutations: (Mutation | undefined)[] }

/** Reads every target and checks the whole batch in order; throws on the first stale or unavailable action. */
export async function plan(gh: GitHub, c: ActionConfig, actions: Action[]): Promise<Plan> {
  const model = new Map<string, Fact>();
  const out: Plan = { states: [], expected: [], mutations: [] };
  for (const [index, a] of actions.entries()) {
    const k = key(a);
    const earlier = model.has(k);
    // An org write is planned only against live state: GitHub may echo a ruleset with defaults added.
    if (earlier && !("repo" in a)) throw new Error(`Action ${index + 1}: one action per organisation variable or ruleset per proposal`);
    const live = await observe(gh, c, a);
    if (!earlier) model.set(k, live.fact);
    const fact = model.get(k)!;
    try { model.set(k, step(a, fact, live.next)); } catch (e) { throw new Error(`Action ${index + 1}: ${(e as Error).message}`); }
    out.expected.push(fact);
    out.mutations.push(live.mutation);
    out.states.push(`${live.title} · now ${JSON.stringify(fact)}${earlier ? " after the earlier actions" : ""} → ${JSON.stringify(model.get(k))}`);
  }
  return out;
}
async function unchanged(gh: GitHub, c: ActionConfig, o: Offered): Promise<void> {
  const all = await comments(gh, c, o.issue);
  if (recorded(all, o, c) || !proposals(all, o.issue, c).some((v) => v.comment.id === o.comment.id && v.comment.updatedAt === o.comment.updatedAt && v.comment.body === o.comment.body)) throw new Error("Proposal changed or already has an execution record");
}

/** `shown` is the plan's `expected` facts the operator saw; execution refuses if live state no longer matches them. */
export async function execute(gh: GitHub, c: ActionConfig, o: Offered, shown: Fact[], progress: (index: number, result: string) => void): Promise<void> {
  // Revalidate even programmatic callers; never trust the object from a UI closure.
  const p = validateProposal(o.proposal, c);
  if (JSON.stringify(p) !== JSON.stringify(proposals([o.comment], o.issue, c)[0]?.proposal)) throw new Error("Proposal does not match its comment");
  const viewer = await gh.send<{ login: string }>("GET", "/user");
  if (viewer.login.toLowerCase() !== c.operator.toLowerCase()) throw new Error(`Execution requires ${c.operator}'s own token`);
  await unchanged(gh, c, o);
  // Re-plan rather than trust `shown`: this checks every precondition again,
  // and a mismatch means a target changed after it was displayed.
  const { expected } = await plan(gh, c, p.actions);
  if (JSON.stringify(expected) !== JSON.stringify(shown)) throw new Error("Stale: a target changed since the proposal was shown; reload it");
  // Record BEFORE mutations: a lost response, closed tab or partial failure must
  // never silently retry. GitHub comments are not a transactional lock; see docs.
  const receipt = await gh.send<{ id: number }>("POST", `/repos/${c.tracker}/issues/${o.issue}/comments`, { body: `${marker(o)}\nExecution reserved; an interrupted execution must be checked manually.` });
  const results: string[] = [];
  try {
    const all = await comments(gh, c, o.issue);
    const records = all.filter((v) => trusted(v, c) && v.body.split("\n")[0] === marker(o)).sort((a, b) => a.databaseId - b.databaseId);
    if (records[0]?.databaseId !== receipt.id) throw new Error("Another execution reserved this proposal first");
    const current = all.find((v) => v.id === o.comment.id);
    if (!current || !trusted(current, c) || current.body !== o.comment.body || current.updatedAt !== o.comment.updatedAt) throw new Error("Proposal changed after reservation");
    for (const [index, a] of p.actions.entries()) {
      try {
        // Just before each write, the live fact must be what the plan predicted
        // after the earlier actions; anything else is a concurrent change.
        const live = await observe(gh, c, a);
        if (JSON.stringify(live.fact) !== JSON.stringify(expected[index])) throw new Error(`Stale ${label(a)}: changed during execution`);
        await live.apply();
        results.push(`${index + 1}. done`); progress(index, "Done");
      } catch (e) {
        // API error text is untrusted; don't publish it as operator-authored
        // markdown where command consumers could interpret it as intent.
        results.push(`${index + 1}. failed or uncertain`); progress(index, "Failed or uncertain; stopped");
        throw e;
      }
    }
  } finally {
    await gh.send("PATCH", `/repos/${c.tracker}/issues/comments/${receipt.id}`, { body: `${marker(o)}\nOperator action results (remaining actions were not attempted):\n${results.join("\n") || "Stopped before the first action."}` });
  }
}
