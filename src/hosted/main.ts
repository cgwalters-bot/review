import { h } from "../dom.ts";
import { personalInfra } from "./personal-infra.ts";

// Access is gated by the service's operator-only network/proxy, not GitHub login.
// Never ship this entry point on Pages. No storage, telemetry or cross-origin reads.
if (window.self === window.top) {
  const mount = h("div", { id: "personal-infra" });
  document.querySelector("#view")?.before(mount);
  async function refresh() {
    if (!document.hidden) {
      try {
        const response = await fetch("/api/v1/state", { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15_000) });
        if (!response.ok) throw new Error("State unavailable");
        const state: unknown = await response.json();
        if (!state || typeof state !== "object" || !("schema" in state) || state.schema !== "review-service/v1") throw new Error("Unsupported state");
        const panel = personalInfra(state);
        mount.replaceChildren(...(panel ? [panel] : []));
      } catch {
        // Don't retain old operational facts as if a failed refresh confirmed them.
        if (mount.childElementCount) mount.replaceChildren(h("p", { role: "status" }, "Personal infrastructure unavailable; reload or wait for the next refresh."));
      }
    }
    setTimeout(refresh, 60_000);
  }
  void refresh();
}
