// Recorded dispatch execution evidence accepted by the shared state model.

export const DISPATCH_POLL_MS = 60_000;

export interface DispatchTitle {
  kind: string;
  owner: string;
  repo: string;
  number: number;
  pool: string | undefined;
}

/** The step a run is at: its job's name, the step's, and when the step started. */
export interface Step {
  job: string;
  name: string;
  since?: string;
}

/** A finished run's result, as its status comment says it. */
export interface DispatchResult {
  /** The comment's text before its markers, as plain text. */
  text: string;
  /** What it handed back (a PR or a comment), when it says. */
  url?: string;
}

export interface DispatchRun {
  id: number;
  url: string;
  title: string;
  /** Undefined for a title not of the dispatch form. */
  target?: DispatchTitle;
  status: string;
  conclusion?: string;
  startedAt: string;
  /** When it last changed: for a finished run, about when it finished. */
  updatedAt: string;
  step?: Step;
  jobsError?: string;
  /** Null when its item has no status comment about it. */
  result?: DispatchResult | null;
  resultError?: string;
}

export interface DispatchData {
  state: "ok" | "unavailable";
  at: number;
  /** Every run of the in-progress and queued lists, newest first. */
  live: DispatchRun[];
  /** Recently finished runs, newest first. */
  finished: DispatchRun[];
  warnings: string[];
}
