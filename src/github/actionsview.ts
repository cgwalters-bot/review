import { h, link } from "../dom.ts";
import type { GitHub } from "./api.ts";
import { execute, loadProposals, plan, type Action, type ActionConfig, type Fact, type Mutation, type Offered, type Plan, type Variable } from "./actions.ts";
import { lineDiffView } from "./diffview.ts";

/** Explicit reads only; mounting the page never discovers or executes proposals. */
export function actionsPanel(gh: GitHub, config: ActionConfig): HTMLElement {
  const body = h("div");
  const status = h("p", { role: "status" });
  const load = h("button", { type: "button" }, "Load proposals");
  const panel = h("details", { class: "operator-actions sec" }, h("summary", {}, "Proposed operator actions (opt in)"),
    h("p", { class: "note" }, "Reads only the 20 most recently updated open tracker issues, at most 100 comments each. Execution uses your own token; interrupted or failed batches cannot be retried here."), load, status, body);
  let busy = false;
  load.addEventListener("click", () => {
    if (busy) return;
    busy = true; load.disabled = true; body.replaceChildren(); status.textContent = "Reading proposals…";
    void loadProposals(gh, config).then(async ({ offers, warnings }) => {
      for (const offer of offers) body.append(await proposalCard(gh, config, offer, () => busy, (v) => { busy = v; load.disabled = v; }));
      status.textContent = offers.length ? `${offers.length} open proposals in this bounded window.` : "No open proposals in this bounded window.";
      for (const warning of warnings) body.append(h("p", { class: "note" }, `Refused issue: ${warning}`));
    }).catch((e: unknown) => { status.textContent = String(e); }).finally(() => { busy = false; load.disabled = false; });
  });
  return panel;
}

/** Where an action lands: its issue or PR, or the organisation and a ruleset's source file at its commit. */
function target(a: Action): Node {
  if ("repo" in a) return link(`https://github.com/${a.repo}/issues/${a.number}`, `${a.repo}#${a.number}`);
  const org = link(`https://github.com/${a.org}`, a.org);
  if (a.type === "set_org_variable") return h("span", {}, org, ` variable ${a.name}`);
  const { repo, path, sha } = a.source;
  return h("span", {}, org, ` ruleset ${a.ruleset_name} from `, link(`https://github.com/${repo}/blob/${sha}/${path}`, `${repo}/${path}@${sha.slice(0, 12)}`));
}

const visibility = (v: { visibility: string; repositories?: string[] | null }): string => `visibility ${v.visibility}${v.repositories ? `: ${v.repositories.join(", ")}` : ""}`;

/** An org action's exact request and what it replaces: the variable's whole value, or a diff of the normalised rulesets. */
function orgChange(a: Action, now: Fact, m: Mutation): Node[] {
  const out: Node[] = [h("p", {}, "Request"), h("pre", {}, `${m.method} ${m.path}\n${JSON.stringify(m.body, null, 2)}`)];
  if (m.diff) out.push(h("p", {}, "Live ruleset → source file, normalised"), lineDiffView(m.diff.live, m.diff.source));
  else if (a.type === "set_org_variable") {
    const v = now as Variable | null;
    out.push(h("p", {}, v ? `Now, ${visibility(v)}:` : "Now: unset"), ...(v ? [h("pre", {}, v.value)] : []), h("p", {}, `New, ${visibility(a)}:`), h("pre", {}, a.value));
  }
  return out;
}

/** A proposal with its live facts and Execute; the inbox's Do card shows it too. */
export async function proposalCard(gh: GitHub, config: ActionConfig, o: Offered, isBusy: () => boolean, setBusy: (v: boolean) => void, planned?: Plan): Promise<HTMLElement> {
  const rows = h("ol");
  const results: HTMLElement[] = [];
  const status = h("p", { role: "status" });
  // The live facts shown here are the ones execution requires to still hold.
  let shown = planned;
  if (!shown) {
    try { shown = await plan(gh, config, o.proposal.actions); }
    catch (e) { status.textContent = `Refused: ${String(e)}`; }
  }
  for (const [i, action] of o.proposal.actions.entries()) {
    const result = h("p", { role: "status" }); results.push(result);
    // Literal JSON is the exact typed mutation.
    const m = shown?.mutations[i];
    rows.append(h("li", {}, target(action), h("pre", {}, JSON.stringify(action, null, 2)), h("p", { class: "note" }, shown?.states[i] ?? ""), ...(m ? orgChange(action, shown!.expected[i]!, m) : []), result));
  }
  const button = h("button", { type: "button" }, "Execute proposal as yourself");
  button.disabled = !shown;
  button.addEventListener("click", () => {
    if (button.disabled || isBusy()) return;
    if (!window.confirm(`Execute ${o.proposal.actions.length} actions as ${config.operator}? Stops at the first failure. This proposal cannot be retried after reservation.`)) return;
    setBusy(true); button.disabled = true; status.textContent = "Executing…";
    void execute(gh, config, o, shown!.expected, (i, result) => { results[i]!.textContent = result; })
      .then(() => { status.textContent = "Executed; result recorded on the proposal issue."; })
      .catch((e: unknown) => { status.textContent = `${String(e)}. Check the proposal issue and targets; do not retry an uncertain action.`; })
      .finally(() => { setBusy(false); });
  });
  return h("section", { class: "operator-proposal" }, h("h3", {}, o.proposal.title), h("p", {}, o.proposal.why),
    link(`https://github.com/${config.tracker}/issues/${o.issue}#issuecomment-${o.comment.databaseId}`, "Proposal comment"), rows, button, status);
}
