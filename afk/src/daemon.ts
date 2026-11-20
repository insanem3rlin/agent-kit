// The AFK daemon loop: poll the backlog, start up to `concurrency` runs, survive their failures,
// and shut down cleanly on Ctrl+C. One AFK run itself is runIssue (src/run.ts).
//
// Choices worth knowing:
// - A finished issue is remembered until the daemon exits, whatever the outcome: a pushed branch or a
//   label swap already keeps it off the backlog's ready list, and a block the backlog could not record
//   (`unmarked`) or an unexpected throw must not turn into a hot retry loop. A restart retries them.
// - A SetupError (the environment is not ready) is the one failure that is retried: the issue is not
//   remembered, and the next poll waits longer each time (doubling, capped), until a run gets through.
// - Sandbox creation is serialized by a mutex around ports.openSandbox, so image builds and container
//   starts never race. Nothing else is shared between runs: each has its own disposable clone.
// - On shutdown every run's AbortSignal is aborted before the sandboxes are closed. Closing makes the
//   agents fail, and runIssue then records nothing for an aborted run (it returns INTERRUPTED), so the
//   interruption never labels an issue. A run that already pushed finishes its label swap normally.
//   A sandbox that is still opening when shutdown starts is closed as soon as it exists.
import type { Backlog } from "./backlog/types.ts";
import type { AfkConfig } from "./config.ts";
import type { AfkEnv } from "./env.ts";
import { INTERRUPTED, SetupError, runIssue } from "./run.ts";
import type { RunInput, RunOutcome, RunPorts, RunSandbox } from "./run.ts";

export const DEFAULT_POLL_MS = 60_000;
export const DEFAULT_MAX_BACKOFF_MS = 15 * 60_000;
export const DEFAULT_SHUTDOWN_MS = 60_000;
export const DEFAULT_NOTIFY_TIMEOUT_MS = 10_000;

export interface SignalSource {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export interface DaemonDeps {
  config: AfkConfig;
  env: AfkEnv;
  repoDir: string;
  /** Whether origin is on GitHub (passed on to runIssue). */
  github: boolean;
  backlog: Backlog;
  ports: RunPorts;
  /** Defaults to the real runIssue. */
  runIssue?: (input: RunInput) => Promise<RunOutcome>;
  fetch?: typeof fetch;
  /** Resolves after `ms`, or early when `signal` aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** One finished line, without the `afk: ` prefix handling: callers of log get complete lines. Defaults to stderr. */
  log?: (line: string) => void;
  signals?: SignalSource;
  /** Called on a second Ctrl+C. Defaults to process.exit. */
  exit?: (code: number) => void;
  pollMs?: number;
  maxBackoffMs?: number;
  /** How long shutdown waits for in-flight runs. */
  shutdownMs?: number;
  notifyTimeoutMs?: number;
}

const realSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function notifyBody(issue: { id: string; title: string }, outcome: RunOutcome): string {
  const head = `Issue #${issue.id} "${issue.title}"`;
  if (outcome.status === "ready") {
    return `${head} is ready for review. Branch ${outcome.branch}${outcome.prUrl ? `, PR ${outcome.prUrl}` : ""}.`;
  }
  return `${head} is blocked: ${outcome.reason.slice(0, 1000)}`;
}

type LoopEvent = "wake" | "resched" | "stop";

/** Run the daemon until SIGINT or SIGTERM. Resolves with the exit code (130 or 143). */
export async function runDaemon(deps: DaemonDeps): Promise<number> {
  const { config, env } = deps;
  const run = deps.runIssue ?? runIssue;
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? realSleep;
  const raw = deps.log ?? ((line: string) => console.error(line));
  const say = (m: string) => raw(`afk: ${m}`);
  const signals: SignalSource = deps.signals ?? process;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  const maxBackoffMs = deps.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const shutdownMs = deps.shutdownMs ?? DEFAULT_SHUTDOWN_MS;
  const notifyUrl = env.AFK_NOTIFY_URL;

  let stopping = false;
  let exitCode = 0;
  let backoffMs = 0;
  const inFlight = new Map<string, Promise<void>>();
  const finished = new Set<string>();
  const liveSandboxes = new Set<RunSandbox>();
  const aborts = new Set<AbortController>();
  const reportedRejected = new Set<string>();

  // One pending loop event; the first to fire wins until the loop consumes it.
  let event = newEvent();
  function newEvent() {
    let resolve!: (e: LoopEvent) => void;
    const promise = new Promise<LoopEvent>((r) => (resolve = r));
    return { promise, resolve };
  }
  const fire = (e: LoopEvent) => event.resolve(e);

  // Serialized sandbox creation.
  let openChain: Promise<unknown> = Promise.resolve();
  const openSandbox: RunPorts["openSandbox"] = (o) => {
    const result = openChain.then(async () => {
      if (stopping) throw new Error("the daemon is shutting down");
      const sandbox = await deps.ports.openSandbox(o);
      if (stopping) {
        await sandbox.close().catch(() => {});
        throw new Error("the daemon is shutting down");
      }
      liveSandboxes.add(sandbox);
      return {
        ...sandbox,
        async close() {
          liveSandboxes.delete(sandbox);
          await sandbox.close();
        },
      } satisfies RunSandbox;
    });
    openChain = result.catch(() => {});
    return result;
  };
  const ports: RunPorts = { ...deps.ports, openSandbox };

  async function notify(text: string): Promise<void> {
    if (!notifyUrl) return;
    try {
      const res = await doFetch(notifyUrl, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: text,
        signal: AbortSignal.timeout(deps.notifyTimeoutMs ?? DEFAULT_NOTIFY_TIMEOUT_MS),
      });
      if (!res.ok) say(`notification failed: HTTP ${res.status}`);
    } catch (e) {
      say(`notification failed: ${message(e)}`);
    }
  }

  async function runOne(issue: { id: string; title: string; body: string; url: string; agent?: RunInput["issue"]["agent"] }): Promise<void> {
    say(`starting issue ${issue.id} "${issue.title}"`);
    let outcome: RunOutcome;
    const ac = new AbortController();
    aborts.add(ac);
    try {
      outcome = await run({ issue, config, env, repoDir: deps.repoDir, github: deps.github, backlog: deps.backlog, ports, log: raw, signal: ac.signal });
    } catch (e) {
      if (stopping) {
        say(`issue ${issue.id} was interrupted by shutdown (${message(e)}); nothing was recorded or sent`);
      } else if (e instanceof SetupError) {
        backoffMs = Math.min(maxBackoffMs, backoffMs ? backoffMs * 2 : pollMs * 2);
        say(`issue ${issue.id}: the environment is not ready (${e.message}); retrying in ${Math.round(backoffMs / 1000)}s, the issue is untouched`);
        fire("resched");
      } else {
        finished.add(issue.id);
        say(`issue ${issue.id}: the run failed unexpectedly and the issue will not be retried until the daemon restarts: ${message(e)}`);
        fire("wake");
      }
      return;
    } finally {
      aborts.delete(ac);
    }
    finished.add(issue.id);
    backoffMs = 0;
    if (outcome.warning) say(`issue ${issue.id}: ${outcome.warning}`);
    // Only runIssue's own interrupted outcome is silent; a real block recorded during shutdown is
    // reported and notified like any other.
    if (outcome.status === "blocked" && outcome.reason === INTERRUPTED) {
      say(`issue ${issue.id} was interrupted by shutdown; nothing was recorded or sent`);
      if (outcome.keptClone) say(`issue ${issue.id}: any work is kept in ${outcome.keptClone}`);
      return;
    }
    if (outcome.status === "ready") {
      say(`issue ${issue.id} is ready on ${outcome.branch}${outcome.prUrl ? ` (${outcome.prUrl})` : ""}`);
    } else {
      say(`issue ${issue.id} is blocked: ${outcome.reason}`);
      if (outcome.unmarked) say(`issue ${issue.id}: the backlog could not record the block (unmarked); it will not be picked again until the daemon restarts`);
      if (outcome.keptClone) say(`issue ${issue.id}: the work is kept in ${outcome.keptClone}`);
    }
    await notify(notifyBody(issue, outcome));
    fire("wake");
  }

  async function poll(): Promise<void> {
    try {
      for (const r of await deps.backlog.listRejected()) {
        if (stopping) return;
        if (inFlight.has(r.id)) continue;
        try {
          await deps.backlog.markBlocked(r.id, r.reason);
        } catch (e) {
          if (reportedRejected.has(r.id)) continue;
          reportedRejected.add(r.id);
          say(`could not mark rejected issue ${r.id} blocked: ${message(e)}`);
          say(`rejected issue ${r.id} stays unmarked and is reported only in this log (once per daemon run): ${r.reason}`);
        }
      }
    } catch (e) {
      say(`could not list rejected issues: ${message(e)}`);
    }
    if (stopping) return;
    let ready;
    try {
      ready = await deps.backlog.listReady();
    } catch (e) {
      say(`could not list ready issues: ${message(e)}`);
      return;
    }
    for (const issue of ready) {
      if (stopping || inFlight.size >= config.concurrency) break;
      if (inFlight.has(issue.id) || finished.has(issue.id)) continue;
      const p = runOne(issue).catch((e) => say(`issue ${issue.id}: ${message(e)}`)).finally(() => inFlight.delete(issue.id));
      inFlight.set(issue.id, p);
    }
  }

  /** Wait for the next poll: the poll interval (or the back-off), a finished run, or shutdown. */
  async function pause(): Promise<void> {
    for (;;) {
      if (stopping) return;
      const ac = new AbortController();
      const kind = await Promise.race([sleep(backoffMs || pollMs, ac.signal).then((): LoopEvent | "timer" => "timer"), event.promise]);
      ac.abort();
      if (kind !== "timer") event = newEvent();
      if (kind !== "resched") return;
    }
  }

  async function loop(): Promise<void> {
    while (!stopping) {
      try {
        await poll();
      } catch (e) {
        say(`poll failed: ${message(e)}`);
      }
      if (stopping) break;
      await pause();
    }
  }

  let shutdownDone: Promise<void> | undefined;
  async function shutdown(): Promise<void> {
    say("shutting down: closing sandboxes and waiting for the runs in flight");
    for (const ac of aborts) ac.abort();
    fire("stop");
    await Promise.allSettled([...liveSandboxes].map((s) => s.close()));
    const ac = new AbortController();
    const settled = Promise.allSettled([...inFlight.values()]).then(() => "settled" as const);
    const timer = sleep(shutdownMs, ac.signal).then(() => "timeout" as const);
    const result = await Promise.race([settled, timer]);
    ac.abort();
    if (result === "timeout" && inFlight.size > 0) {
      say(`gave up waiting; still running: ${[...inFlight.keys()].join(", ")}. Their run clones may remain in the system temp directory.`);
    }
  }

  const handler = (signal: "SIGINT" | "SIGTERM") => () => {
    const code = signal === "SIGINT" ? 130 : 143;
    if (stopping) {
      say("second interrupt, exiting at once");
      exit(code);
      return;
    }
    stopping = true;
    exitCode = code;
    shutdownDone = shutdown();
  };
  const onInt = handler("SIGINT");
  const onTerm = handler("SIGTERM");
  signals.on("SIGINT", onInt);
  signals.on("SIGTERM", onTerm);
  say(`watching for ready issues (poll every ${Math.round(pollMs / 1000)}s, up to ${config.concurrency} at once); Ctrl+C to stop`);
  try {
    await loop();
    await shutdownDone;
  } finally {
    signals.off("SIGINT", onInt);
    signals.off("SIGTERM", onTerm);
  }
  return exitCode;
}
