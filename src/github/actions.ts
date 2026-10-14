// Provisional tracker#582 contract; see docs/operator-actions.md. No proposal
// supplies an API path, credential, trusted writer, repository allowlist or project.
import type { GitHub } from "./api.ts";
import rawConfig from "./action-config.json" with { type: "json" };
import { matchesActionSchema } from "./actionschema.ts";

const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/;
const LOGIN = /^[A-Za-z0-9-]+(?:\[bot\])?$/;
const SHA = /^[a-f0-9]{40}$/;
const STAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;
export const ACTION_SCHEMA = "agent-board/operator-action/v1";
export const MAX_ACTIONS = 20;

export interface ActionConfig { operator: string; planner: string; tracker: string; repositories: string[]; project: string }

export function actionConfig(value: unknown): ActionConfig | undefined {
  const c = value as ActionConfig;
  if (c && c.operator === "" && c.planner === "" && c.tracker === "" && c.project === "" && Array.isArray(c.repositories) && !c.repositories.length) return undefined;
  if (!c || typeof c.operator !== "string" || !LOGIN.test(c.operator) || typeof c.planner !== "string" || !LOGIN.test(c.planner) || typeof c.tracker !== "string" || !REPO.test(c.tracker)
    || !Array.isArray(c.repositories) || !c.repositories.length || c.repositories.length > 100
    || c.repositories.some((r) => typeof r !== "string" || !REPO.test(r))
    || typeof c.project !== "string" || (c.project !== "" && !/^PVT_[A-Za-z0-9_]+$/.test(c.project))) throw new Error("Invalid operator action configuration");
  return c;
}

export const ACTION_CONFIG = actionConfig(rawConfig);
interface Target { repo: string; number: number; updatedAt: string }
export type Action = Target & (
  | { type: "close_issue"; reason: string }
  | { type: "reopen_issue" }
  | { type: "add_label" | "remove_label"; label: string }
  | { type: "approve_pr"; head: string }
  | { type: "merge_pr"; head: string; method: "merge" | "squash" | "rebase" }
  | { type: "set_project_field"; field: "Priority" | "Status"; from: string | null; value: string }
  | { type: "add_sub_issue" | "move_sub_issue"; parent: Target; previousParent: string | null }
);
export interface Proposal { schema: typeof ACTION_SCHEMA; title: string; why: string; actions: Action[] }

function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("Expected an object");
  return v as Record<string, unknown>;
}

function keys(v: Record<string, unknown>, names: string[]): void {
  if (Object.keys(v).length !== names.length || names.some((k) => !Object.hasOwn(v, k))) throw new Error("Missing or unknown action property");
}

function text(v: unknown, max: number): v is string { return typeof v === "string" && v.trim().length > 0 && v.length <= max; }

function target(v: Record<string, unknown>, c: ActionConfig): void {
  if (typeof v.repo !== "string" || !REPO.test(v.repo) || !c.repositories.some((r) => r.toLowerCase() === (v.repo as string).toLowerCase())
    || !Number.isSafeInteger(v.number) || (v.number as number) < 1 || typeof v.updatedAt !== "string" || !STAMP.test(v.updatedAt) || !Number.isFinite(Date.parse(v.updatedAt))) throw new Error("Invalid or disallowed action target");
}

export function validateProposal(value: unknown, c: ActionConfig): Proposal {
  if (!matchesActionSchema(value)) throw new Error("Proposal does not match the operator action schema");
  const p = object(value);
  keys(p, ["schema", "title", "why", "actions"]);
  if (p.schema !== ACTION_SCHEMA || !text(p.title, 200) || /[\r\n]/.test(p.title) || !text(p.why, 2000)
    || !Array.isArray(p.actions) || !p.actions.length || p.actions.length > MAX_ACTIONS) throw new Error("Invalid operator action proposal");
  const seen = new Set<string>();
  for (const value of p.actions) {
    const a = object(value);
    target(a, c);
    // A second mutation of a target would invalidate its own updatedAt guard.
    const id = `${(a.repo as string).toLowerCase()}#${a.number}`;
    if (seen.has(id)) throw new Error("Only one action per target per proposal");
    seen.add(id);
    const base = ["type", "repo", "number", "updatedAt"];
    switch (a.type) {
      case "close_issue": keys(a, [...base, "reason"]); if (!text(a.reason, 4000) || /^\s*\/(?:promote|draft|ready)\b/im.test(a.reason)) throw new Error("Invalid close reason"); break;
      case "reopen_issue": keys(a, base); break;
      // "." and ".." survive encodeURIComponent and URL parsing collapses them, so
      // DELETE …/labels/. would reach the remove-all-labels endpoint.
      case "add_label": case "remove_label": keys(a, [...base, "label"]); if (!text(a.label, 50) || /[\r\n]/.test(a.label) || /^\.{1,2}$/.test(a.label)) throw new Error("Invalid label"); break;
      case "approve_pr": case "merge_pr":
        keys(a, [...base, "head", ...(a.type === "merge_pr" ? ["method"] : [])]);
        if (typeof a.head !== "string" || !SHA.test(a.head) || (a.type === "merge_pr" && !["merge", "squash", "rebase"].includes(a.method as string))) throw new Error("Invalid PR action");
        break;
      case "set_project_field":
        keys(a, [...base, "field", "from", "value"]);
        if (!c.project || !["Priority", "Status"].includes(a.field as string) || !(a.from === null || text(a.from, 100)) || !text(a.value, 100)) throw new Error("Invalid project action");
        break;
      case "add_sub_issue": case "move_sub_issue": {
        keys(a, [...base, "parent", "previousParent"]);
        const parent = object(a.parent); keys(parent, ["repo", "number", "updatedAt"]); target(parent, c);
        if (`${(parent.repo as string).toLowerCase()}#${parent.number}` === id
          || (a.type === "add_sub_issue" ? a.previousParent !== null : typeof a.previousParent !== "string" || !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+#[1-9][0-9]*$/.test(a.previousParent))) throw new Error("Invalid parent precondition");
        if (typeof a.previousParent === "string" && !c.repositories.some((r) => r.toLowerCase() === (a.previousParent as string).split("#")[0]!.toLowerCase())) throw new Error("Previous parent repository is not allowed");
        break;
      }
      default: throw new Error("Unknown operator action type");
    }
  }
  return p as unknown as Proposal;
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

function checkContainingIssue(p: Proposal, issue: number, c: ActionConfig): void {
  const contains = (t: Target): boolean => t.repo.toLowerCase() === c.tracker.toLowerCase() && t.number === issue;
  // The reservation and receipt edit change this issue's timestamp. Refuse it
  // before reserving rather than exempting our writes from the freshness guard.
  if (p.actions.some((a) => contains(a) || ((a.type === "add_sub_issue" || a.type === "move_sub_issue") && contains(a.parent)))) throw new Error("An action cannot target or use its containing proposal issue as a parent; propose it on another issue");
}

export function proposals(all: Comment[], issue: number, c: ActionConfig): Offered[] {
  const out: Offered[] = [];
  for (const comment of all) {
    if (!trusted(comment, c)) continue;
    const blocks = [...comment.body.matchAll(/^```agent-board-action\r?\n([\s\S]*?)^```[ \t]*\r?$/gm)];
    if (!blocks.length) continue;
    if (blocks.length !== 1 || comment.body.length > 65536) throw new Error("Ambiguous or oversized operator action comment");
    const proposal = validateProposal(JSON.parse(blocks[0]![1]!), c);
    checkContainingIssue(proposal, issue, c);
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

interface Issue { id: number; node_id: string; title: string; state: string; updated_at: string; pull_request?: unknown; labels: { name: string }[]; parent_issue_url?: string | null }
interface Prepared { state: string; apply(): Promise<void> }

async function readTarget(gh: GitHub, t: Target): Promise<Issue> {
  const i = await gh.send<Issue>("GET", `/repos/${t.repo}/issues/${t.number}`);
  if (i.updated_at !== t.updatedAt) throw new Error(`Stale ${t.repo}#${t.number}: ${i.title} is ${i.state}, updated ${i.updated_at}; expected ${t.updatedAt}`);
  return i;
}

export async function prepare(gh: GitHub, c: ActionConfig, a: Action): Promise<Prepared> {
  const i = await readTarget(gh, a);
  const path = `/repos/${a.repo}/issues/${a.number}`;
  const state = `${i.title} · ${i.state} · updated ${i.updated_at} · labels: ${i.labels.map((l) => l.name).join(", ") || "none"}`;
  const send = async (method: string, url: string, body?: unknown): Promise<void> => { await gh.send(method, url, body); };
  if (a.type === "approve_pr" || a.type === "merge_pr") {
    const prPath = `/repos/${a.repo}/pulls/${a.number}`;
    const pr = await gh.send<{ state: string; merged: boolean; draft: boolean; head: { sha: string } }>("GET", prPath);
    if (pr.state !== "open" || pr.merged || pr.draft || pr.head.sha !== a.head) throw new Error(`Stale PR: current head ${pr.head.sha}, state ${pr.state}${pr.draft ? " draft" : ""}`);
    return { state: `${state} · head ${pr.head.sha}`, apply: async () => {
      if (a.type === "approve_pr") await send("POST", `${prPath}/reviews`, { event: "APPROVE", commit_id: a.head });
      else {
        const result = await gh.send<{ merged: boolean; message: string }>("PUT", `${prPath}/merge`, { sha: a.head, merge_method: a.method });
        if (!result.merged) throw new Error(`Not merged: ${result.message}`);
      }
    } };
  }
  if (a.type === "close_issue" || a.type === "reopen_issue") {
    if (i.pull_request || i.state !== (a.type === "close_issue" ? "open" : "closed")) throw new Error("Stale issue state or target is a PR");
    return { state, apply: async () => {
      if (a.type === "close_issue") await send("POST", `${path}/comments`, { body: a.reason });
      await send("PATCH", path, { state: a.type === "close_issue" ? "closed" : "open" });
    } };
  }
  if (a.type === "add_label" || a.type === "remove_label") {
    if (/^\.{1,2}$/.test(a.label)) throw new Error("Invalid label");
    if (i.labels.some((l) => l.name.toLowerCase() === a.label.toLowerCase()) !== (a.type === "remove_label")) throw new Error("Stale label membership");
    return { state, apply: () => a.type === "add_label" ? send("POST", `${path}/labels`, { labels: [a.label] }) : send("DELETE", `${path}/labels/${encodeURIComponent(a.label)}`) };
  }
  if (a.type === "add_sub_issue" || a.type === "move_sub_issue") {
    const parent = await readTarget(gh, a.parent);
    const previous = a.previousParent === null ? null : `https://api.github.com/repos/${a.previousParent.replace("#", "/issues/")}`;
    if (i.pull_request || parent.pull_request || (i.parent_issue_url ?? null)?.toLowerCase() !== previous?.toLowerCase()) throw new Error("Stale parent relationship or PR target");
    return { state: `${state} · parent ${a.previousParent ?? "none"} → ${a.parent.repo}#${a.parent.number}: ${parent.title}`, apply: () => send("POST", `/repos/${a.parent.repo}/issues/${a.parent.number}/sub_issues`, { sub_issue_id: i.id, replace_parent: a.type === "move_sub_issue" }) };
  }
  if (a.type !== "set_project_field") throw new Error("Unsupported operator action");
  const data = await graphql<{ node: { projectItems: { nodes: { id: string; project: { id: string }; fieldValueByName: { name: string } | null }[]; pageInfo: { hasNextPage: boolean } } }; project: { fields: { nodes: { id: string; name: string; options?: { id: string; name: string }[] }[]; pageInfo: { hasNextPage: boolean } } } }>(gh,
    `query($issue:ID!,$project:ID!,$field:String!){node(id:$issue){... on Issue{projectItems(first:100){nodes{id project{id} fieldValueByName(name:$field){... on ProjectV2ItemFieldSingleSelectValue{name}}} pageInfo{hasNextPage}}} ... on PullRequest{projectItems(first:100){nodes{id project{id} fieldValueByName(name:$field){... on ProjectV2ItemFieldSingleSelectValue{name}}} pageInfo{hasNextPage}}}} project:node(id:$project){... on ProjectV2{fields(first:100){nodes{... on ProjectV2SingleSelectField{id name options{id name}}} pageInfo{hasNextPage}}}}}`, { issue: i.node_id, project: c.project, field: a.field });
  const items = data.node.projectItems;
  const fields = data.project.fields;
  const item = items.nodes.find((v) => v.project.id === c.project);
  const field = fields.nodes.find((v) => v.name === a.field);
  const option = field?.options?.find((v) => v.name === a.value);
  if (items.pageInfo.hasNextPage || fields.pageInfo.hasNextPage || !item || !field || !option || (item.fieldValueByName?.name ?? null) !== a.from) throw new Error("Stale or unavailable project field");
  return { state: `${state} · ${a.field}: ${a.from ?? "unset"} → ${a.value}`, apply: async () => {
    await graphql(gh, `mutation($project:ID!,$item:ID!,$field:ID!,$option:String!){updateProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field,value:{singleSelectOptionId:$option}}){projectV2Item{id}}}`, { project: c.project, item: item.id, field: field.id, option: option.id });
  } };
}

async function unchanged(gh: GitHub, c: ActionConfig, o: Offered): Promise<void> {
  const all = await comments(gh, c, o.issue);
  if (recorded(all, o, c) || !proposals(all, o.issue, c).some((v) => v.comment.id === o.comment.id && v.comment.updatedAt === o.comment.updatedAt && v.comment.body === o.comment.body)) throw new Error("Proposal changed or already has an execution record");
}

export async function execute(gh: GitHub, c: ActionConfig, o: Offered, progress: (index: number, result: string) => void): Promise<void> {
  // Revalidate even programmatic callers; never trust the object from a UI closure.
  const p = validateProposal(o.proposal, c);
  checkContainingIssue(p, o.issue, c);
  if (JSON.stringify(p) !== JSON.stringify(proposals([o.comment], o.issue, c)[0]?.proposal)) throw new Error("Proposal does not match its comment");
  const viewer = await gh.send<{ login: string }>("GET", "/user");
  if (viewer.login.toLowerCase() !== c.operator.toLowerCase()) throw new Error(`Execution requires ${c.operator}'s own token`);
  await unchanged(gh, c, o);
  for (const a of p.actions) await prepare(gh, c, a);
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
        const next = await prepare(gh, c, a);
        await next.apply();
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
