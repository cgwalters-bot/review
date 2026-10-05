import { FileView, type FileHooks, type FileInit } from "../../src/github/diffview.ts";
import type { DraftComment } from "../../src/github/forge.ts";
import type { FileDiff } from "../../src/github/prs.ts";
import type { DiffLayout } from "../../src/github/store.ts";

export const fileDiff = (over: Partial<FileDiff> = {}): FileDiff => ({
  filename: "a.txt", status: "modified", additions: 3, deletions: 2,
  patch: "@@ -2,3 +2,4 @@ section\n context\n-value old\n+value new\n+extra\n tail\n@@ -10 +11 @@ last\n-end\n+finish",
  ...over,
});

/** A file with mutable layout/drafts and recorded pane callbacks. */
export function fileViewFixture(over: Partial<Omit<FileInit, "hooks">> = {}, hookOver: Partial<FileHooks> = {}) {
  const state = { layout: "unified" as DiffLayout, drafts: [] as DraftComment[], loads: 0 };
  const calls = {
    saved: [] as [DraftComment, DraftComment | undefined][],
    deleted: [] as DraftComment[],
    focused: [] as Parameters<FileHooks["focused"]>[],
    viewed: [] as Parameters<FileHooks["setViewed"]>[],
    hotspots: [] as number[],
  };
  const hooks: FileHooks = {
    layout: () => state.layout,
    commentable: (row, side) => !row.expanded && (side === "LEFT" ? row.old : row.new) !== undefined,
    loadLines: async () => (state.loads++, Array.from({ length: 15 }, (_, i) => `line ${i + 1}`)),
    drafts: () => state.drafts,
    saveDraft: (draft, old) => {
      calls.saved.push([draft, old]);
      state.drafts = state.drafts.filter((d) => d !== old).concat(draft);
    },
    deleteDraft: (draft) => {
      calls.deleted.push(draft);
      state.drafts = state.drafts.filter((d) => d !== draft);
    },
    focused: (...args) => calls.focused.push(args),
    setViewed: (...args) => calls.viewed.push(args),
    sawHotspot: (index) => calls.hotspots.push(index),
    commit: "e".repeat(40),
    base: "0".repeat(40),
    ...hookOver,
  };
  const view = new FileView({ file: fileDiff(), hotspots: [], skim: [], viewed: false, ...over, hooks });
  document.body.replaceChildren(view.el);
  return { view, state, calls, hooks };
}
