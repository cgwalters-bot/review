// The poll loop: one poll at a time, the next one scheduled when it
// settles, paused while the tab is hidden, slowed or paused by the rate
// budget. A poll that never settles must not end the loop: after a
// stall timeout it is given up on and the loop goes on without it. And
// the loop says why the data on screen is getting old (pollNote), so a
// paused or stuck loop shows as such rather than as a quiet "cached".
//
// A page can also be suspended without its timers firing (mobile Safari
// in the background, the back-forward cache), so waking it (shown,
// restored or focused) checks the loop: a poll from before the
// suspension is given up on, and stale data is re-read at once.
//
// Kept apart from main.ts, with the poll and visibility injected, so
// tests can drive it with fake timers.

import type { RateLimit } from "./api.ts";

/** How long until the next poll, and, when it isn't the usual interval, why (shown as is). */
export interface Delay {
  ms: number;
  why?: string;
}

export interface PollerHooks {
  /**
   * One poll. It may reject; the loop goes on. `current()` turns false
   * once the loop gave up on it: it should then drop what it read, as a
   * newer poll may have shown something fresher.
   */
  run(current: () => boolean): Promise<void>;
  delay(): Delay;
  hidden(): boolean;
  /** Called whenever status() may have changed. */
  changed?(): void;
  /** Abandon the requests still waiting that were sent before this time (epoch ms). */
  abort?(before: number): void;
  /** A suspension shorter than this (ms) is ignored on waking; default SUSPEND_MIN_MS. */
  suspendMinMs?: number;
  /** Give up on a poll after this long (ms). */
  stallMs: number;
}

export interface PollStatus {
  closed: boolean;
  hidden: boolean;
  /** When the running poll started (epoch ms), if one is running. */
  running?: number;
  /** When the next poll is due, and why it is later than usual. */
  next?: { at: number; why?: string };
  /** Polls given up on in a row, reset by one that settles. */
  stalls: number;
  /** Set until the first poll starts (e.g. while the token is checked at load). */
  starting?: true;
}

/** A suspension this short (a quick tab switch) leaves the running poll and its requests alone. */
export const SUSPEND_MIN_MS = 10_000;

export class Poller {
  readonly #hooks: PollerHooks;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #stallTimer: ReturnType<typeof setTimeout> | undefined;
  /** Which poll is the running one; a poll given up on settles unheard. */
  #gen = 0;
  #running: { gen: number; since: number } | undefined;
  #next: { at: number; why?: string } | undefined;
  #again = false;
  #closed = false;
  #stalls = 0;
  #started = false;
  /** When the last poll settled (not given up on). */
  #settledAt: number | undefined;
  /** When the page was last seen hidden or put away, until it wakes. */
  #suspendedAt: number | undefined;

  constructor(hooks: PollerHooks) {
    this.#hooks = hooks;
  }

  /** Poll now, or right after the running poll if there is one. */
  now(): void {
    if (this.#closed) return;
    if (this.#running) this.#again = true;
    else this.#start();
  }

  /**
   * The tab was hidden or shown: stop the timer, or wake (see wake()).
   * `frozenSince` is as for wake().
   */
  visibilityChanged(frozenSince?: number): void {
    if (this.#closed) return;
    if (!this.#hooks.hidden()) {
      this.wake(frozenSince);
      return;
    }
    this.suspend();
    clearTimeout(this.#timer);
    this.#next = undefined;
    this.#changed();
  }

  /** The page is being put away (hidden, or into the back-forward cache): it may be frozen from now on. */
  suspend(): void {
    this.#suspendedAt ??= Date.now();
  }

  /**
   * The page may have been suspended and is in use again (shown,
   * restored from the back-forward cache, or focused); `frozenSince` is
   * when its timers were last seen running, if they have since missed
   * their time. After a suspension of at least suspendMinMs, a poll
   * started before it is given up on and replaced at once, and the
   * requests sent before it abandoned: such a request can hang for
   * good. Otherwise, unless a poll is running, poll at once if the last
   * one is older than the usual delay, else make sure the next is due.
   */
  wake(frozenSince?: number): void {
    if (this.#closed || this.#hooks.hidden()) return;
    const since = [this.#suspendedAt, frozenSince].reduce<number | undefined>((a, b) => (b === undefined ? a : Math.min(a ?? b, b)), undefined);
    this.#suspendedAt = undefined;
    if (since !== undefined && Date.now() - since >= (this.#hooks.suspendMinMs ?? SUSPEND_MIN_MS)) {
      try {
        this.#hooks.abort?.(since);
      } catch (e) {
        console.error("review: abandoning requests failed:", e);
      }
      if (this.#running && this.#running.since <= since) {
        this.#drop();
        this.#start();
        return;
      }
    }
    if (this.#running) return;
    const d = this.#delay();
    const due = this.#settledAt === undefined ? Date.now() : this.#settledAt + d.ms;
    if (due <= Date.now()) this.#start();
    else if (!this.#next || this.#next.at > due) this.#scheduleAt(due, d.why);
  }

  close(): void {
    this.#closed = true;
    clearTimeout(this.#timer);
    clearTimeout(this.#stallTimer);
  }

  status(): PollStatus {
    const s: PollStatus = { closed: this.#closed, hidden: this.#hooks.hidden(), stalls: this.#stalls };
    if (this.#running) s.running = this.#running.since;
    if (this.#next) s.next = this.#next;
    if (!this.#started) s.starting = true;
    return s;
  }

  /** A failing hook mustn't stop the loop. */
  #changed(): void {
    try {
      this.#hooks.changed?.();
    } catch (e) {
      console.error("review: updating the poll status failed:", e);
    }
  }

  #start(): void {
    clearTimeout(this.#timer);
    this.#next = undefined;
    this.#started = true;
    const gen = ++this.#gen;
    this.#running = { gen, since: Date.now() };
    this.#stallTimer = setTimeout(() => this.#settled(gen, true), this.#hooks.stallMs);
    this.#changed();
    let p: Promise<void>;
    try {
      p = this.#hooks.run(() => this.#running?.gen === gen);
    } catch (e) {
      p = Promise.reject(e);
    }
    p.catch((e: unknown) => console.error("review: poll failed:", e)).finally(() => this.#settled(gen, false));
  }

  /** Give up on the running poll without waiting for it, as for a stall but not counted as one; the poll started next covers any asked for meanwhile. */
  #drop(): void {
    clearTimeout(this.#stallTimer);
    this.#running = undefined;
    this.#again = false;
  }

  #settled(gen: number, stalled: boolean): void {
    if (this.#running?.gen !== gen) return;
    clearTimeout(this.#stallTimer);
    this.#running = undefined;
    if (stalled) {
      this.#stalls++;
      console.warn(`review: a poll hasn't settled after ${this.#hooks.stallMs / 1000} s; going on without it`);
    } else {
      this.#stalls = 0;
      this.#settledAt = Date.now();
    }
    if (this.#closed) return;
    if (this.#again) {
      this.#again = false;
      this.#start();
      return;
    }
    this.#schedule();
  }

  #delay(): Delay {
    try {
      return this.#hooks.delay();
    } catch (e) {
      console.error("review: computing the poll delay failed:", e);
      return { ms: this.#hooks.stallMs };
    }
  }

  #schedule(): void {
    if (!this.#hooks.hidden()) {
      const d = this.#delay();
      this.#scheduleAt(Date.now() + d.ms, d.why);
      return;
    }
    this.#changed();
  }

  #scheduleAt(at: number, why: string | undefined): void {
    clearTimeout(this.#timer);
    this.#next = why === undefined ? { at } : { at, why };
    this.#timer = setTimeout(() => this.#start(), Math.max(0, at - Date.now()));
    this.#changed();
  }
}

export interface DelayPolicy {
  interval: number;
  /** Poll this many times slower when the budget is low. */
  backoff: number;
  /** Below this fraction of the budget, it is low. */
  lowFraction: number;
  /** Formats a time of day for the label. */
  clock: (ms: number) => string;
}

/** Past the rate budget's reset, wait this much longer for GitHub's clock. */
const RESET_SLACK_MS = 5_000;

/**
 * The next poll's delay under the rate budget: usual, slowed when low, or
 * paused until it resets when spent, or until `blockedUntil` (epoch ms)
 * when GitHub refused a request for a rate limit and said when to retry.
 */
export function pollDelay(rate: RateLimit | undefined, now: number, p: DelayPolicy, blockedUntil = 0): Delay {
  if (blockedUntil > now) return { ms: Math.max(p.interval, blockedUntil - now), why: `paused: GitHub rate limit until ${p.clock(blockedUntil)}` };
  if (!rate) return { ms: p.interval };
  const reset = rate.reset * 1000;
  if (rate.remaining <= 0 && reset > now) return { ms: Math.max(p.interval, reset - now + RESET_SLACK_MS), why: `paused: rate limit until ${p.clock(reset)}` };
  if (rate.remaining < rate.limit * p.lowFraction) return { ms: p.interval * p.backoff, why: "slowed: rate limit low" };
  return { ms: p.interval };
}

/** Minutes or seconds, for the waiting note. */
function ago(ms: number): string {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min`;
}

/** What the header says while the cached copy on screen is being re-read. */
export const REFRESHING_NOTE = "refreshing…";

/**
 * Why the data on screen may be getting old, for the header next to its
 * age; undefined while polling as usual. `cached` is whether the view
 * shows a cached copy this loop re-reads: it then always gets a reason,
 * so a bare "cached · N min ago" never sits there unexplained.
 */
export function pollNote(s: PollStatus, now: number, slowMs: number, cached = false): string | undefined {
  if (s.closed) return undefined;
  if (s.hidden) return "paused: tab hidden";
  if (s.starting) return cached ? REFRESHING_NOTE : undefined;
  if (s.running !== undefined) {
    const waited = now - s.running;
    if (s.stalls > 0) return `retrying: GitHub didn't answer the last ${s.stalls === 1 ? "poll" : `${s.stalls} polls`}`;
    if (waited >= slowMs) return `waiting on GitHub for ${ago(waited)}`;
    return cached ? REFRESHING_NOTE : undefined;
  }
  if (s.stalls > 0) return `stalled: GitHub didn't answer the last ${s.stalls === 1 ? "poll" : `${s.stalls} polls`}`;
  if (s.next?.why) return s.next.why;
  if (!cached) return undefined;
  // The last poll settled but didn't replace the cached copy: it failed (the notice says why).
  return s.next ? `couldn't refresh; retrying in ${ago(Math.max(0, s.next.at - now))}` : "not refreshing: press r";
}
