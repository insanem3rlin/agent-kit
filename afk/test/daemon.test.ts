import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { Backlog, BacklogIssue, RejectedIssue } from "../src/backlog/types.ts";
import type { AfkConfig } from "../src/config.ts";
import { DEFAULT_POLL_MS, runDaemon } from "../src/daemon.ts";
import type { DaemonDeps } from "../src/daemon.ts";
import { SetupError } from "../src/run.ts";
import type { RunInput, RunOutcome, RunPorts, RunSandbox } from "../src/run.ts";

const config: AfkConfig = { backlog: "github", label: "afk", baseBranch: "main", implementer: "claude", reviewer: "claude", concurrency: 2 };
const mk = (id: string): BacklogIssue => ({ id, title: `Issue ${id}`, body: "", url: `https://example.test/${id}` });

interface Deferred<T> {
  promise: Promise<T>;
  resolve(v: T): void;
  reject(e: unknown): void;
}
function deferred<T = void>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => ((resolve = a), (reject = b)));
  return { promise, resolve, reject };
}

async function until(cond: () => boolean, what = "condition"): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    if (cond()) return;
    await new Promise((r) => (i < 200 ? setImmediate(r) : setTimeout(r, 2)));
  }
  assert.fail(`timed out waiting for ${what}`);
}

interface Harness {
  deps: DaemonDeps;
  logs: string[];
  sleeps: { ms: number; fire(): void }[];
  signals: EventEmitter;
  exits: number[];
  ready: BacklogIssue[];
  rejected: RejectedIssue[];
  blocked: { id: string; reason: string }[];
  readyMarked: string[];
  started: string[];
  fetches: { url: string; init: RequestInit }[];
  done: Promise<number>;
  start(): void;
}

interface Options {
  concurrency?: number;
  ready?: BacklogIssue[];
  rejected?: RejectedIssue[];
  run?: (input: RunInput, h: Harness) => Promise<RunOutcome>;
  notifyUrl?: string;
  fetch?: typeof fetch;
  failMarkBlocked?: boolean;
  shutdownMs?: number;
}

function harness(o: Options = {}): Harness {
  const h = { logs: [], sleeps: [], exits: [], blocked: [], readyMarked: [], started: [], fetches: [], signals: new EventEmitter(), ready: o.ready ?? [], rejected: o.rejected ?? [] } as unknown as Harness;
  const backlog: Backlog = {
    async listReady() {
      return h.ready;
    },
    async listRejected() {
      return h.rejected;
    },
    async markBlocked(id, reason) {
      if (o.failMarkBlocked) throw new Error("gh is down");
      h.blocked.push({ id, reason });
    },
    async markReadyForHuman(id) {
      h.readyMarked.push(id);
    },
    async comment() {},
  };
  const ports = {
    async openSandbox() {
      throw new Error("the fake runIssue opens it itself");
    },
  } as unknown as RunPorts;
  h.deps = {
    config: { ...config, concurrency: o.concurrency ?? 2 },
    env: { ...(o.notifyUrl ? { AFK_NOTIFY_URL: o.notifyUrl } : {}) },
    repoDir: "/repo",
    github: true,
    backlog,
    ports,
    runIssue: async (input) => {
      h.started.push(input.issue.id);
      return o.run ? o.run(input, h) : { status: "ready", branch: `afk/${input.issue.id}` };
    },
    fetch:
      o.fetch ??
      (async (url, init) => {
        h.fetches.push({ url: String(url), init: init as RequestInit });
        return new Response("ok", { status: 200 });
      }),
    sleep: (ms, signal) =>
      new Promise<void>((resolve) => {
        const entry = { ms, fire: () => resolve() };
        h.sleeps.push(entry);
        signal?.addEventListener(
          "abort",
          () => {
            const i = h.sleeps.indexOf(entry);
            if (i >= 0) h.sleeps.splice(i, 1);
            resolve();
          },
          { once: true },
        );
      }),
    log: (line) => h.logs.push(line),
    signals: h.signals,
    exit: (code) => h.exits.push(code),
    shutdownMs: o.shutdownMs ?? 5000,
  };
  h.start = () => {
    h.done = runDaemon(h.deps);
  };
  return h;
}

/** The oldest live sleep, resolved so the loop moves on. */
const nextPoll = async (h: Harness) => {
  await until(() => h.sleeps.length > 0, "a sleep");
  h.sleeps.shift()!.fire();
};

test("a poll starts ready issues up to the concurrency limit and does not restart issues in flight", async () => {
  const gates = new Map<string, Deferred<RunOutcome>>();
  const h = harness({
    ready: [mk("1"), mk("2"), mk("3")],
    concurrency: 2,
    run: (input) => {
      const d = deferred<RunOutcome>();
      gates.set(input.issue.id, d);
      return d.promise;
    },
  });
  h.start();
  await until(() => h.started.length === 2, "two runs");
  assert.deepEqual(h.started, ["1", "2"]);
  assert.equal(h.sleeps[0].ms, DEFAULT_POLL_MS);
  await nextPoll(h);
  await until(() => h.sleeps.length > 0, "second sleep");
  assert.deepEqual(h.started, ["1", "2"], "no third run while two are in flight, and none twice");
  gates.get("1")!.resolve({ status: "ready", branch: "afk/1" });
  await until(() => h.started.length === 3, "third run after a slot freed");
  assert.deepEqual(h.started, ["1", "2", "3"]);
  h.signals.emit("SIGINT");
  gates.get("2")!.resolve({ status: "ready", branch: "afk/2" });
  gates.get("3")!.resolve({ status: "ready", branch: "afk/3" });
  assert.equal(await h.done, 130);
});

test("every rejected entry is marked blocked with its reason, except ids in flight", async () => {
  const gate = deferred<RunOutcome>();
  const h = harness({
    ready: [mk("1")],
    run: () => gate.promise,
  });
  h.start();
  await until(() => h.started.length === 1);
  h.rejected = [
    { id: "1", reason: "two agent labels" },
    { id: "9", reason: "unknown agent label" },
  ];
  await nextPoll(h);
  await until(() => h.blocked.length === 1);
  assert.deepEqual(h.blocked, [{ id: "9", reason: "unknown agent label" }]);
  h.signals.emit("SIGINT");
  gate.resolve({ status: "ready", branch: "afk/1" });
  await h.done;
});

test("a failing markBlocked is logged and the loop keeps polling", async () => {
  const h = harness({ rejected: [{ id: "9", reason: "bad" }], failMarkBlocked: true });
  h.start();
  await nextPoll(h);
  await nextPoll(h);
  assert.ok(h.logs.some((l) => /^afk: .*9.*gh is down/.test(l)), h.logs.join("\n"));
  h.signals.emit("SIGINT");
  assert.equal(await h.done, 130);
});

test("a rejected issue that cannot be marked is reported once, not on every poll", async () => {
  const h = harness({ rejected: [{ id: "9", reason: "bad" }], failMarkBlocked: true });
  h.start();
  await nextPoll(h);
  await nextPoll(h);
  await nextPoll(h);
  await until(() => h.sleeps.length > 0);
  assert.equal(h.logs.filter((l) => /could not mark rejected issue 9/.test(l)).length, 1);
  assert.ok(h.logs.some((l) => /only in this log|reported in this log/.test(l)));
  h.signals.emit("SIGINT");
  await h.done;
});

test("a failing listReady is logged and the loop keeps polling", async () => {
  const h = harness();
  let calls = 0;
  h.deps.backlog.listReady = async () => {
    if (calls++ === 0) throw new Error("rate limited");
    return [];
  };
  h.start();
  await nextPoll(h);
  await nextPoll(h);
  assert.ok(calls >= 2);
  assert.ok(h.logs.some((l) => /rate limited/.test(l)));
  h.signals.emit("SIGTERM");
  assert.equal(await h.done, 143);
});

test("sandbox creation is serialized across concurrent runs", async () => {
  let inOpen = 0;
  let maxInOpen = 0;
  const opened: string[] = [];
  const baseOpen = async (): Promise<RunSandbox> => {
    inOpen++;
    maxInOpen = Math.max(maxInOpen, inOpen);
    await new Promise((r) => setTimeout(r, 5));
    inOpen--;
    opened.push("x");
    return { runAgent: async () => {}, readFile: async () => null, removeFile: async () => {}, close: async () => {} };
  };
  const h = harness({
    ready: [mk("1"), mk("2"), mk("3")],
    concurrency: 3,
    run: async (input) => {
      const box = await input.ports.openSandbox({ branch: "b", baseRef: "r", repoDir: "/repo", runDir: "/run", env: {} });
      await box.close();
      return { status: "ready", branch: `afk/${input.issue.id}` };
    },
  });
  h.deps.ports.openSandbox = baseOpen;
  h.start();
  await until(() => opened.length === 3, "three opens");
  assert.equal(maxInOpen, 1);
  h.signals.emit("SIGINT");
  await h.done;
});

test("a failed openSandbox does not block the next one", async () => {
  let n = 0;
  const h = harness({
    ready: [mk("1"), mk("2")],
    run: async (input) => {
      try {
        await input.ports.openSandbox({ branch: "b", baseRef: "r", repoDir: "/repo", runDir: "/run", env: {} });
      } catch {
        n++;
      }
      return { status: "ready", branch: "x" };
    },
  });
  h.deps.ports.openSandbox = async () => {
    throw new Error("docker down");
  };
  h.start();
  await until(() => n === 2, "both opens attempted");
  h.signals.emit("SIGINT");
  await h.done;
});

test("SetupError backs off with a growing delay, does not relabel, and the issue is retried", async () => {
  let attempts = 0;
  const h = harness({
    ready: [mk("1")],
    concurrency: 1,
    run: async () => {
      if (++attempts < 3) throw new SetupError("docker is not running");
      return { status: "ready", branch: "afk/1" };
    },
    notifyUrl: "https://notify.test/x",
  });
  h.start();
  await until(() => h.sleeps.some((x) => x.ms > DEFAULT_POLL_MS), "a back-off longer than the poll interval");
  const first = h.sleeps.find((x) => x.ms > DEFAULT_POLL_MS)!;
  h.sleeps.splice(h.sleeps.indexOf(first), 1);
  first.fire();
  await until(() => h.sleeps.some((x) => x.ms > first.ms), "a longer back-off");
  const second = h.sleeps.find((x) => x.ms > first.ms)!;
  h.sleeps.splice(h.sleeps.indexOf(second), 1);
  second.fire();
  await until(() => attempts === 3);
  await until(() => h.fetches.length === 1, "notify after the success only");
  assert.deepEqual(h.blocked, []);
  assert.ok(h.logs.some((l) => /docker is not running/.test(l) && /^afk: /.test(l)));
  h.signals.emit("SIGINT");
  await h.done;
});

test("the back-off is capped", async () => {
  const h = harness({
    ready: [mk("1")],
    concurrency: 1,
    run: async () => {
      throw new SetupError("nope");
    },
  });
  h.deps.pollMs = 1000;
  h.deps.maxBackoffMs = 4000;
  h.start();
  const seen: number[] = [];
  for (const want of [2000, 4000, 4000, 4000]) {
    await until(() => h.sleeps.some((x) => x.ms === want), `a ${want} ms back-off`);
    const e = h.sleeps.find((x) => x.ms === want)!;
    h.sleeps.splice(h.sleeps.indexOf(e), 1);
    seen.push(e.ms);
    e.fire();
  }
  assert.deepEqual(seen, [2000, 4000, 4000, 4000]);
  h.signals.emit("SIGINT");
  await h.done;
});

test("any other throw is logged, the loop survives and the issue is not picked again", async () => {
  const h = harness({
    ready: [mk("1"), mk("2")],
    concurrency: 1,
    run: async (input) => {
      if (input.issue.id === "1") throw new Error("boom");
      return { status: "ready", branch: "afk/2" };
    },
  });
  h.start();
  await until(() => h.started.length === 2, "second issue runs");
  await nextPoll(h);
  await nextPoll(h);
  assert.deepEqual(h.started, ["1", "2"], "issue 1 is quarantined");
  assert.ok(h.logs.some((l) => /boom/.test(l)));
  assert.deepEqual(h.blocked, []);
  h.signals.emit("SIGINT");
  await h.done;
});

test("an unmarked block is never picked again, and kept clones and warnings are logged", async () => {
  const outcomes: Record<string, RunOutcome> = {
    "1": { status: "blocked", reason: "no sandbox", unmarked: true },
    "2": { status: "blocked", reason: "push failed", keptClone: "/tmp/run-2" },
    "3": { status: "ready", branch: "afk/3", warning: "label swap failed" },
  };
  const h = harness({ ready: [mk("1"), mk("2"), mk("3")], concurrency: 3, run: async (i) => outcomes[i.issue.id] });
  h.start();
  await until(() => h.started.length === 3);
  await nextPoll(h);
  await nextPoll(h);
  assert.deepEqual(h.started.filter((x) => x === "1"), ["1"]);
  const all = h.logs.join("\n");
  assert.match(all, /\/tmp\/run-2/);
  assert.match(all, /label swap failed/);
  assert.match(all, /1.*unmarked|unmarked.*1/);
  h.signals.emit("SIGINT");
  await h.done;
});

test("SIGINT stops polling, closes every live sandbox, waits for the runs and exits 130", async () => {
  const closed: string[] = [];
  const gate = deferred<RunOutcome>();
  let box: RunSandbox | undefined;
  const h = harness({
    ready: [mk("1")],
    concurrency: 1,
    run: async (input) => {
      box = await input.ports.openSandbox({ branch: "afk/1", baseRef: "r", repoDir: "/repo", runDir: "/run/1", env: {} });
      return gate.promise;
    },
  });
  h.deps.ports.openSandbox = async () => ({
    runAgent: async () => {},
    readFile: async () => null,
    removeFile: async () => {},
    close: async () => void closed.push("closed"),
  });
  h.start();
  await until(() => box !== undefined);
  h.signals.emit("SIGINT");
  await until(() => closed.length === 1, "sandbox closed");
  let finished = false;
  void h.done.then(() => (finished = true));
  await new Promise((r) => setImmediate(r));
  assert.equal(finished, false, "waits for the in-flight run");
  gate.resolve({ status: "blocked", reason: "sandbox closed" });
  assert.equal(await h.done, 130);
  assert.deepEqual(h.exits, []);
  // closing again through the run's own handle is harmless
  await box!.close();
});

test("after SIGINT nothing new starts, and an interrupted run is neither notified nor relabelled by the daemon", async () => {
  const gate = deferred<void>();
  let signal: AbortSignal | undefined;
  const h = harness({
    ready: [mk("1"), mk("2")],
    concurrency: 1,
    notifyUrl: "https://notify.test/x",
    run: async (input) => {
      signal = input.signal;
      await gate.promise;
      return { status: "blocked", reason: "interrupted by shutdown", unmarked: true };
    },
  });
  h.start();
  await until(() => h.started.length === 1);
  assert.equal(signal?.aborted, false);
  h.signals.emit("SIGINT");
  assert.equal(signal?.aborted, true, "the run's signal is aborted when shutdown starts");
  gate.resolve();
  assert.equal(await h.done, 130);
  assert.deepEqual(h.started, ["1"]);
  assert.deepEqual(h.blocked, []);
  assert.deepEqual(h.fetches, []);
  assert.ok(h.logs.some((l) => /interrupted/.test(l)));
});

test("a real block recorded during shutdown is notified and logged as a block", async () => {
  const gate = deferred<void>();
  const h = harness({
    ready: [mk("1")],
    notifyUrl: "https://notify.test/x",
    run: async () => {
      await gate.promise;
      return { status: "blocked", reason: "the branch touches .github/workflows/**" };
    },
  });
  h.start();
  await until(() => h.started.length === 1);
  h.signals.emit("SIGINT");
  gate.resolve();
  assert.equal(await h.done, 130);
  assert.equal(h.fetches.length, 1);
  assert.match(h.fetches[0].init.body as string, /workflows/);
  assert.ok(!h.logs.some((l) => /nothing was recorded/.test(l)), h.logs.join("\n"));
});

test("a run that finishes ready during shutdown still gets its label swap and a notification", async () => {
  const gate = deferred<void>();
  const h = harness({
    ready: [mk("1")],
    notifyUrl: "https://notify.test/x",
    run: async (input) => {
      await gate.promise;
      await input.backlog.markReadyForHuman(input.issue.id, "done");
      return { status: "ready", branch: "afk/1" };
    },
  });
  h.start();
  await until(() => h.started.length === 1);
  h.signals.emit("SIGINT");
  gate.resolve();
  assert.equal(await h.done, 130);
  assert.deepEqual(h.readyMarked, ["1"]);
  assert.equal(h.fetches.length, 1);
});

test("a sandbox that finishes opening after Ctrl+C is closed at once and the run gets an error", async () => {
  const gate = deferred<void>();
  const events: string[] = [];
  let results: string[] = [];
  const h = harness({
    ready: [mk("1"), mk("2")],
    concurrency: 2,
    run: async (input) => {
      try {
        await input.ports.openSandbox({ branch: `afk/${input.issue.id}`, baseRef: "r", repoDir: "/repo", runDir: "/run", env: {} });
        results.push(`${input.issue.id}:opened`);
      } catch (e) {
        results.push(`${input.issue.id}:${(e as Error).message}`);
      }
      return { status: "blocked", reason: "interrupted by shutdown", unmarked: true };
    },
  });
  h.deps.ports.openSandbox = async (o) => {
    events.push(`open:${o.branch}`);
    await gate.promise;
    return { runAgent: async () => {}, readFile: async () => null, removeFile: async () => {}, close: async () => void events.push(`close:${o.branch}`) };
  };
  h.start();
  await until(() => events.includes("open:afk/1"));
  h.signals.emit("SIGINT");
  gate.resolve();
  assert.equal(await h.done, 130);
  assert.deepEqual(events, ["open:afk/1", "close:afk/1"], "the open in flight is closed, the queued open never starts");
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => !r.endsWith(":opened")), results.join());
});

test("a SetupError racing with Ctrl+C does not start a back-off sleep", async () => {
  const gate = deferred<void>();
  const h = harness({
    ready: [mk("1")],
    concurrency: 1,
    run: async () => {
      await gate.promise;
      throw new SetupError("docker is not running");
    },
  });
  const orig = h.deps.log!;
  h.deps.log = (line) => {
    orig(line);
    // One microtask after the log line, the "resched" has fired but pause() has not resumed yet.
    if (/not ready/.test(line)) queueMicrotask(() => h.signals.emit("SIGINT"));
  };
  h.start();
  await until(() => h.started.length === 1);
  await until(() => h.sleeps.length > 0);
  gate.resolve();
  assert.equal(await h.done, 130);
  assert.deepEqual(h.sleeps.filter((s) => s.ms > DEFAULT_POLL_MS), []);
});

test("a second Ctrl+C exits at once", async () => {
  const gate = deferred<RunOutcome>();
  const h = harness({ ready: [mk("1")], run: () => gate.promise });
  h.start();
  await until(() => h.started.length === 1);
  h.signals.emit("SIGINT");
  h.signals.emit("SIGINT");
  assert.deepEqual(h.exits, [130]);
  gate.resolve({ status: "ready", branch: "x" });
  await h.done;
});

test("the shutdown wait is bounded, and runs still in flight are logged", async () => {
  const gate = deferred<RunOutcome>();
  const h = harness({ ready: [mk("1")], run: () => gate.promise, shutdownMs: 1234 });
  h.start();
  await until(() => h.started.length === 1);
  h.signals.emit("SIGINT");
  await until(() => h.sleeps.some((s) => s.ms === 1234), "the shutdown timer");
  h.sleeps.find((s) => s.ms === 1234)!.fire();
  assert.equal(await h.done, 130);
  assert.ok(h.logs.some((l) => /still running/.test(l) && /1/.test(l)));
  gate.resolve({ status: "ready", branch: "x" });
});

test("AFK_NOTIFY_URL gets one plain-text POST per ready or blocked run", async () => {
  const h = harness({
    ready: [mk("1"), mk("2")],
    notifyUrl: "https://notify.test/x",
    run: async (input) =>
      input.issue.id === "1"
        ? { status: "ready", branch: "afk/1", prUrl: "https://example.test/pr/1" }
        : { status: "blocked", reason: "tests keep failing" },
  });
  h.start();
  await until(() => h.fetches.length === 2, "two notifications");
  const byBody = h.fetches.map((f) => f.init.body as string);
  const ready = byBody.find((b) => b.includes("Issue 1"))!;
  const blocked = byBody.find((b) => b.includes("Issue 2"))!;
  assert.match(ready, /1/);
  assert.match(ready, /afk\/1/);
  assert.match(ready, /https:\/\/example\.test\/pr\/1/);
  assert.match(blocked, /blocked/);
  assert.match(blocked, /tests keep failing/);
  for (const f of h.fetches) {
    assert.equal(f.url, "https://notify.test/x");
    assert.equal(f.init.method, "POST");
    assert.equal((f.init.headers as Record<string, string>)["content-type"], "text/plain");
    assert.ok(f.init.signal, "has a timeout signal");
  }
  h.signals.emit("SIGINT");
  await h.done;
});

test("no notify URL, no POST", async () => {
  const h = harness({ ready: [mk("1")] });
  h.start();
  await until(() => h.started.length === 1);
  await nextPoll(h);
  assert.deepEqual(h.fetches, []);
  h.signals.emit("SIGINT");
  await h.done;
});

test("a failed notification, by throw or by status, is logged and changes nothing", async () => {
  for (const f of [
    async () => {
      throw new Error("network down");
    },
    async () => new Response("no", { status: 500 }),
  ]) {
    const h = harness({ ready: [mk("1"), mk("2")], notifyUrl: "https://notify.test/x", fetch: f as typeof fetch });
    h.start();
    await until(() => h.started.length === 2);
    await until(() => h.logs.filter((l) => /notif/.test(l)).length === 2, "two notify failures logged");
    await nextPoll(h);
    h.signals.emit("SIGINT");
    assert.equal(await h.done, 130);
  }
});
