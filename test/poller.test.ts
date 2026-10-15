import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { type Delay, type PollStatus, Poller, pollDelay, pollNote, REFRESHING_NOTE } from "../src/github/poller.ts";

const INTERVAL = 30_000;
const STALL = 120_000;

/** Let settled polls' callbacks run (setImmediate isn't faked). */
const flush = () => new Promise<void>((r) => setImmediate(r));

/**
 * A poller over scripted polls: each call of run() takes the next
 * behaviour from `script` (resolve by default), "hang" never settles.
 */
function harness(script: ("ok" | "fail" | "hang")[] = []) {
  let runs = 0;
  let hidden = false;
  let delay: Delay = { ms: INTERVAL };
  const poller = new Poller({
    run: () => {
      const what = script[runs++] ?? "ok";
      if (what === "hang") return new Promise<void>(() => {});
      return what === "fail" ? Promise.reject(new Error("offline")) : Promise.resolve();
    },
    delay: () => delay,
    hidden: () => hidden,
    stallMs: STALL,
  });
  return {
    poller,
    runs: () => runs,
    setHidden: (h: boolean) => {
      hidden = h;
      poller.visibilityChanged();
    },
    setDelay: (d: Delay) => {
      delay = d;
    },
  };
}

describe("Poller", () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    mock.method(console, "error", () => {});
    mock.method(console, "warn", () => {});
  });
  afterEach(() => {
    mock.timers.reset();
    mock.restoreAll();
  });

  it("polls every interval while visible", async () => {
    const h = harness();
    h.poller.now();
    await flush();
    for (let i = 0; i < 3; i++) {
      mock.timers.tick(INTERVAL);
      await flush();
    }
    assert.equal(h.runs(), 4);
    assert.deepEqual(h.poller.status(), { closed: false, hidden: false, next: { at: 4 * INTERVAL }, stalls: 0 });
  });

  // The bug: a poll whose request never came back held the loop's lock
  // forever, so the queue stayed "cached · N min ago" until a reload.
  it("goes on after a poll that never settles", async () => {
    const h = harness(["hang", "hang"]);
    h.poller.now();
    await flush();
    // Asked again (r, or after an action) while stuck: it waits, but not forever.
    h.poller.now();
    mock.timers.tick(STALL - 1);
    await flush();
    assert.equal(h.runs(), 1);
    assert.equal(pollNote(h.poller.status(), Date.now(), 10_000), "waiting on GitHub for 1 min");
    mock.timers.tick(1);
    await flush();
    assert.equal(h.runs(), 2, "the queued poll starts once the stuck one is given up on");
    assert.equal(pollNote(h.poller.status(), Date.now(), 10_000), "retrying: GitHub didn't answer the last poll");
    // That one hangs too: given up on, and the next is scheduled as usual.
    mock.timers.tick(STALL);
    await flush();
    assert.equal(pollNote(h.poller.status(), Date.now(), 10_000), "stalled: GitHub didn't answer the last 2 polls");
    mock.timers.tick(INTERVAL);
    await flush();
    assert.equal(h.runs(), 3);
    assert.equal(h.poller.status().stalls, 0);
  });

  it("ignores a poll it gave up on when that one settles late", async () => {
    const releases: (() => void)[] = [];
    const currents: (() => boolean)[] = [];
    const poller = new Poller({
      run: (current) => {
        currents.push(current);
        return new Promise<void>((r) => releases.push(r));
      },
      delay: () => ({ ms: INTERVAL }),
      hidden: () => false,
      stallMs: STALL,
    });
    poller.now();
    mock.timers.tick(STALL);
    await flush();
    // Given up on; the next one starts after the usual interval.
    assert.equal(currents[0]?.(), false);
    mock.timers.tick(INTERVAL);
    await flush();
    assert.equal(currents.length, 2);
    assert.equal(currents[1]?.(), true);
    // The first settles now: nothing moves, the second is still the running one.
    releases[0]?.();
    await flush();
    assert.equal(currents.length, 2);
    assert.equal(poller.status().running, STALL + INTERVAL);
    assert.equal(poller.status().stalls, 1);
    releases[1]?.();
    await flush();
    assert.deepEqual(poller.status(), { closed: false, hidden: false, next: { at: STALL + 2 * INTERVAL }, stalls: 0 });
  });

  it("goes on when its hooks throw", async () => {
    let runs = 0;
    const poller = new Poller({
      run: () => {
        runs++;
        return Promise.resolve();
      },
      delay: () => {
        throw new Error("delay");
      },
      hidden: () => false,
      changed: () => {
        throw new Error("changed");
      },
      stallMs: STALL,
    });
    poller.now();
    await flush();
    mock.timers.tick(STALL);
    await flush();
    assert.equal(runs, 2);
  });

  it("goes on after a poll that fails, or throws before its promise", async () => {
    let runs = 0;
    const poller = new Poller({
      run: () => {
        runs++;
        if (runs === 1) throw new Error("sync");
        return Promise.reject(new Error("async"));
      },
      delay: () => ({ ms: INTERVAL }),
      hidden: () => false,
      stallMs: STALL,
    });
    poller.now();
    await flush();
    mock.timers.tick(INTERVAL);
    await flush();
    mock.timers.tick(INTERVAL);
    await flush();
    assert.equal(runs, 3);
  });

  it("runs one poll at a time, and one more if asked meanwhile", async () => {
    let release: () => void = () => {};
    let runs = 0;
    const poller = new Poller({
      run: () => {
        runs++;
        return new Promise<void>((r) => {
          release = r;
        });
      },
      delay: () => ({ ms: INTERVAL }),
      hidden: () => false,
      stallMs: STALL,
    });
    poller.now();
    poller.now();
    poller.now();
    assert.equal(runs, 1);
    release();
    await flush();
    assert.equal(runs, 2, "the asks while running coalesce into one poll");
    release();
    await flush();
    assert.equal(runs, 2);
  });

  it("pauses while the tab is hidden and polls on showing it", async () => {
    const h = harness();
    h.poller.now();
    await flush();
    h.setHidden(true);
    assert.equal(pollNote(h.poller.status(), Date.now(), 10_000), "paused: tab hidden");
    mock.timers.tick(10 * INTERVAL);
    await flush();
    assert.equal(h.runs(), 1);
    h.setHidden(false);
    await flush();
    assert.equal(h.runs(), 2);
    assert.equal(pollNote(h.poller.status(), Date.now(), 10_000), undefined);
  });

  it("doesn't schedule a poll that settles while hidden", async () => {
    let release: () => void = () => {};
    let hidden = false;
    let runs = 0;
    const poller = new Poller({
      run: () => {
        runs++;
        return new Promise<void>((r) => {
          release = r;
        });
      },
      delay: () => ({ ms: INTERVAL }),
      hidden: () => hidden,
      stallMs: STALL,
    });
    poller.now();
    hidden = true;
    poller.visibilityChanged();
    release();
    await flush();
    mock.timers.tick(10 * INTERVAL);
    await flush();
    assert.equal(runs, 1);
  });

  it("on showing the tab, re-reads only data older than the interval", async () => {
    const h = harness();
    h.poller.now();
    await flush();
    h.setHidden(true);
    mock.timers.tick(INTERVAL / 3);
    h.setHidden(false);
    await flush();
    assert.equal(h.runs(), 1, "still fresh: no poll");
    assert.deepEqual(h.poller.status().next, { at: INTERVAL }, "the next one is due when it would have been");
    mock.timers.tick(INTERVAL - INTERVAL / 3);
    await flush();
    assert.equal(h.runs(), 2);
  });

  /** A poller whose polls all hang, recording what it gives up on and abandons. */
  function hanging() {
    const aborted: number[] = [];
    const currents: (() => boolean)[] = [];
    let hidden = false;
    const poller = new Poller({
      run: (current) => {
        currents.push(current);
        return new Promise<void>(() => {});
      },
      delay: () => ({ ms: INTERVAL }),
      hidden: () => hidden,
      abort: (before) => aborted.push(before),
      stallMs: STALL,
    });
    const setHidden = (v: boolean) => {
      hidden = v;
      poller.visibilityChanged();
    };
    return { poller, aborted, currents, setHidden };
  }

  // The bug: mobile Safari froze the page mid-poll; back in front, the
  // poll's request never settled and the header said only "cached".
  const SUSPENDED_AT = 1_000;
  const resumes: [string, (h: ReturnType<typeof hanging>) => void][] = [
    ["shown again", (h) => h.setHidden(false)],
    // Restored from the back-forward cache, or thawed: no visibilitychange, and the ticker missed its turns.
    ["woken with its timers frozen", (h) => h.poller.wake(SUSPENDED_AT)],
  ];
  for (const [name, resume] of resumes) {
    it(`drops a poll from before a suspension, and its requests, when ${name}`, async () => {
      const h = hanging();
      h.poller.now();
      mock.timers.tick(SUSPENDED_AT);
      if (name === "shown again") h.setHidden(true);
      // Frozen for a while: the stall timer never got to fire.
      mock.timers.setTime(SUSPENDED_AT + 10 * 60_000);
      resume(h);
      await flush();
      assert.equal(h.currents.length, 2, "a new poll starts at once");
      assert.equal(h.currents[0]?.(), false, "the old one is given up on");
      assert.equal(h.currents[1]?.(), true);
      assert.deepEqual(h.aborted, [SUSPENDED_AT]);
      assert.equal(h.poller.status().stalls, 0, "not counted as a stall");
      assert.equal(pollNote(h.poller.status(), Date.now(), 10_000, true), REFRESHING_NOTE);
    });
  }

  it("leaves a running poll alone across a quick tab switch, and a refresh asked for meanwhile", async () => {
    const h = hanging();
    h.poller.now();
    mock.timers.tick(5_000);
    h.setHidden(true);
    mock.timers.tick(2_000);
    h.poller.now();
    h.setHidden(false);
    await flush();
    assert.equal(h.currents.length, 1);
    assert.equal(h.currents[0]?.(), true);
    assert.deepEqual(h.aborted, []);
  });

  it("leaves a running poll alone when focused without a suspension", async () => {
    const h = hanging();
    h.poller.now();
    mock.timers.tick(5_000);
    h.poller.wake();
    await flush();
    assert.equal(h.currents.length, 1);
    assert.deepEqual(h.aborted, []);
  });

  it("polls on waking when the loop sat idle", async () => {
    // Shown without hearing of it, and no poll since: wake() restarts it.
    const h = harness();
    h.setDelay({ ms: 4 * INTERVAL, why: "slowed: rate limit low" });
    h.poller.wake();
    await flush();
    assert.equal(h.runs(), 1);
    // Slowed by the rate budget: even after a suspension, waking doesn't poll before the slower delay is up.
    mock.timers.tick(2 * INTERVAL);
    h.poller.wake(INTERVAL);
    await flush();
    assert.equal(h.runs(), 1);
    assert.deepEqual(h.poller.status().next, { at: 4 * INTERVAL, why: "slowed: rate limit low" });
  });

  it("waits the delay it is given, and says why", async () => {
    const h = harness();
    h.setDelay({ ms: 4 * INTERVAL, why: "slowed: rate limit low" });
    h.poller.now();
    await flush();
    assert.equal(pollNote(h.poller.status(), Date.now(), 10_000), "slowed: rate limit low");
    mock.timers.tick(4 * INTERVAL - 1);
    await flush();
    assert.equal(h.runs(), 1);
    mock.timers.tick(1);
    await flush();
    assert.equal(h.runs(), 2);
  });

  it("stops when closed", async () => {
    const h = harness();
    h.poller.now();
    await flush();
    h.poller.close();
    h.poller.now();
    mock.timers.tick(10 * INTERVAL);
    await flush();
    assert.equal(h.runs(), 1);
  });
});

describe("pollDelay", () => {
  const policy = { interval: INTERVAL, backoff: 4, lowFraction: 0.1, clock: (ms: number) => `t${ms / 1000}` };
  const now = 1_000_000;
  const cases: [string, Parameters<typeof pollDelay>[0], Delay][] = [
    ["no rate known yet", undefined, { ms: INTERVAL }],
    ["plenty left", { limit: 5000, remaining: 4766, reset: 2000 }, { ms: INTERVAL }],
    ["low", { limit: 5000, remaining: 499, reset: 2000 }, { ms: 4 * INTERVAL, why: "slowed: rate limit low" }],
    ["spent: until the reset", { limit: 5000, remaining: 0, reset: 2000 }, { ms: 1_005_000, why: "paused: rate limit until t2000" }],
    ["spent, reset imminent: at least the interval", { limit: 5000, remaining: 0, reset: 1001 }, { ms: INTERVAL, why: "paused: rate limit until t1001" }],
    ["spent, reset passed: low", { limit: 5000, remaining: 0, reset: 999 }, { ms: 4 * INTERVAL, why: "slowed: rate limit low" }],
  ];
  for (const [name, rate, want] of cases) it(name, () => assert.deepEqual(pollDelay(rate, now, policy), want));
  it("refused for a rate limit: until GitHub said to retry, at least the interval", () => {
    const plenty = { limit: 5000, remaining: 4766, reset: 2000 };
    assert.deepEqual(pollDelay(plenty, now, policy, now + 90_000), { ms: 90_000, why: "paused: GitHub rate limit until t1090" });
    assert.deepEqual(pollDelay(plenty, now, policy, now + 1_000), { ms: INTERVAL, why: "paused: GitHub rate limit until t1001" });
    assert.deepEqual(pollDelay(plenty, now, policy, now - 1), { ms: INTERVAL });
  });
});

describe("pollNote", () => {
  const base: PollStatus = { closed: false, hidden: false, stalls: 0 };
  const now = 1_000_000;
  const cases: [string, PollStatus, string | undefined][] = [
    ["polling as usual", { ...base, next: { at: now + 1 } }, undefined],
    ["a poll just started", { ...base, running: now - 5_000 }, undefined],
    ["a slow poll", { ...base, running: now - 45_000 }, "waiting on GitHub for 45 s"],
    ["a very slow poll", { ...base, running: now - 150_000 }, "waiting on GitHub for 2 min"],
    ["after a stall", { ...base, stalls: 1, next: { at: now + 1 } }, "stalled: GitHub didn't answer the last poll"],
    ["retrying after stalls", { ...base, stalls: 3, running: now }, "retrying: GitHub didn't answer the last 3 polls"],
    ["hidden", { ...base, hidden: true, stalls: 2 }, "paused: tab hidden"],
    ["rate limited", { ...base, next: { at: now + 1, why: "paused: rate limit until 14:05" } }, "paused: rate limit until 14:05"],
    ["closed", { ...base, closed: true, hidden: true }, undefined],
    ["not started yet", { ...base, starting: true }, undefined],
  ];
  for (const [name, s, want] of cases) it(name, () => assert.equal(pollNote(s, now, 10_000), want));

  // Over a cached copy there is always a reason, never a bare "cached · N min ago".
  const cachedCases: [string, PollStatus, string][] = [
    ["re-reading it", { ...base, running: now - 2_000 }, REFRESHING_NOTE],
    ["re-reading it slowly", { ...base, running: now - 45_000 }, "waiting on GitHub for 45 s"],
    ["the re-read failed", { ...base, next: { at: now + 20_000 } }, "couldn't refresh; retrying in 20 s"],
    ["rate limited", { ...base, next: { at: now + 1, why: "paused: rate limit until 14:05" } }, "paused: rate limit until 14:05"],
    ["the loop idle", base, "not refreshing: press r"],
    // Shown from the cache at load, while the token is still being checked.
    ["the first poll not started yet", { ...base, starting: true }, REFRESHING_NOTE],
    ["hidden", { ...base, hidden: true }, "paused: tab hidden"],
  ];
  for (const [name, s, want] of cachedCases) it(`cached, ${name}`, () => assert.equal(pollNote(s, now, 10_000, true), want));
});
