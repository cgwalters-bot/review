// agent-board's operator-action contract; see docs/operator-actions.md. No proposal
// supplies an API path, credential, trusted writer, repository allowlist or project ID.
import type { GitHub } from "./api.ts";
import rawConfig from "./action-config.json" with { type: "json" };
import { matchesActionSchema } from "./actionschema.ts";

const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/;
const LOGIN = /^[A-Za-z0-9-]+(?:\[bot\])?$/;
const PROJECT = /^https:\/\/github\.com\/(orgs|users)\/[A-Za-z0-9_][A-Za-z0-9_-]{0,38}\/projects\/[1-9][0-9]{0,14}$/;
export const ACTION_SCHEMA = "agent-board/operator-action/v1";

/** `project` is the one project URL proposals may write to, or empty to refuse project-field actions. */
export interface ActionConfig { operator: string; planner: string; tracker: string; repositories: string[]; project: string }

export function actionConfig(value: unknown): ActionConfig | undefined {
  const c = value as ActionConfig;
  if (c && c.operator === "" && c.planner === "" && c.tracker === "" && c.project === "" && Array.isArray(c.repositories) && !c.repositories.length) return undefined;
  if (!c || typeof c.operator !== "string" || !LOGIN.test(c.operator) || typeof c.planner !== "string" || !LOGIN.test(c.planner) || typeof c.tracker !== "string" || !REPO.test(c.tracker)
    || !Array.isArray(c.repositories) || !c.repositories.length || c.repositories.length > 100
    || c.repositories.some((r) => typeof r !== "string" || !REPO.test(r))
    || typeof c.project !== "string" || (c.project !== "" && !PROJECT.test(c.project))) throw new Error("Invalid operator action configuration");
  return c;
}

export const ACTION_CONFIG = actionConfig(rawConfig);
// agent-board's names. The proposal carries no timestamps or prior values:
// staleness is judged against live state shown to the operator (see plan()).
interface Target { repo: string; number: number }
export type Action = Target & (
  | { type: "close_issue"; reason: string }
  | { type: "reopen_issue" }
  | { type: "add_label" | "remove_label"; label: string }
  | { type: "approve_pull_request"; head_sha: string }
  | { type: "merge_pull_request"; head_sha: string; method: "merge" | "squash" | "rebase" }
  | { type: "set_project_field"; project: string; field: "Priority" | "Status"; value: string }
  | { type: "add_sub_issue"; parent_repo: string; parent_number: number }
  | { type: "move_sub_issue"; parent_repo: string; parent_number: number; previous_parent_repo: string; previous_parent_number: number }
);
export interface Proposal { schema: typeof ACTION_SCHEMA; title: string; why: string; actions: Action[] }

const ref = (repo: string, number: number): string => `${repo.toLowerCase()}#${number}`;

export function validateProposal(value: unknown, c: ActionConfig): Proposal {
  if (!matchesActionSchema(value)) throw new Error("Proposal does not match the operator action schema");
  const p = value as Proposal;
  const allowed = (repo: string): boolean => c.repositories.some((r) => r.toLowerCase() === repo.toLowerCase());
  for (const a of p.actions) {
    if (!allowed(a.repo)) throw new Error(`Repository ${a.repo} is not allowed`);
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
/** The live fact an action depends on: issue state, label membership, PR state and head, parent, or field value. */
export type Fact = string | boolean | null;
interface Observed { title: string; fact: Fact; apply(): Promise<void> }

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
  const path = `/repos/${a.repo}/issues/${a.number}`;
  const send = async (method: string, url: string, body?: unknown): Promise<void> => { await gh.send(method, url, body); };
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
  const t = ref(a.repo, a.number);
  switch (a.type) {
    case "close_issue": case "reopen_issue": return `${t} state`;
    case "add_label": case "remove_label": return `${t} label ${a.label.toLowerCase()}`;
    case "approve_pull_request": case "merge_pull_request": return `${t} pull`;
    case "add_sub_issue": case "move_sub_issue": return `${t} parent`;
    case "set_project_field": return `${t} ${a.project.toLowerCase()} ${a.field}`;
  }
}

// Checks the action's precondition against the fact and returns the fact after it.
function step(a: Action, fact: Fact): Fact {
  const want = (ok: boolean, expected: string): void => { if (!ok) throw new Error(`Stale ${a.repo}#${a.number}: expected ${expected}, found ${JSON.stringify(fact)}`); };
  switch (a.type) {
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
export interface Plan { states: string[]; expected: Fact[] }

/** Reads every target and checks the whole batch in order; throws on the first stale or unavailable action. */
export async function plan(gh: GitHub, c: ActionConfig, actions: Action[]): Promise<Plan> {
  const model = new Map<string, Fact>();
  const out: Plan = { states: [], expected: [] };
  for (const [index, a] of actions.entries()) {
    const live = await observe(gh, c, a);
    const k = key(a);
    const earlier = model.has(k);
    if (!earlier) model.set(k, live.fact);
    const fact = model.get(k)!;
    try { model.set(k, step(a, fact)); } catch (e) { throw new Error(`Action ${index + 1}: ${(e as Error).message}`); }
    out.expected.push(fact);
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
        if (JSON.stringify(live.fact) !== JSON.stringify(expected[index])) throw new Error(`Stale ${a.repo}#${a.number}: changed during execution`);
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
