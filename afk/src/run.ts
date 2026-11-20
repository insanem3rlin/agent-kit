// One AFK run: an implementer phase, then a reviewer phase, in one sandbox on one
// branch `afk/<id>`, ending in a pushed branch (a draft PR on GitHub) or a blocked
// issue. The daemon loop (#8) calls runIssue.
//
// Everything that touches Docker, git, gh or the file system sits behind RunPorts
// (src/sandbox.ts and src/hostgit.ts have the real ones), so the orchestration is tested
// with fakes. The agents never talk to GitHub or the backlog and never push: the run does.
//
// The security boundary is described in hostgit.ts: the shared `.git` is writable from the
// container, so after the agents ran the run reads only one value from it (the branch tip),
// and does every guard, the Backlog.md label swap and the push in a fresh clone.
//
// After a successful push the run never throws. Opening the PR, posting the Spec findings,
// swapping the label and pushing the swap commit are each tried on their own, and a failure
// becomes a `warning` on a `ready` outcome: the branch is on the remote, so the issue is
// claimed and the work exists, and reporting it blocked would be wrong.
import type { Backlog, BacklogIssue } from "./backlog/types.ts";
import type { AfkConfig, AgentName } from "./config.ts";
import { AGENT_TOKEN_VARS, requireSecrets } from "./env.ts";
import type { AfkEnv } from "./env.ts";
import { githubSlug } from "./hostgit.ts";
import type { CleanClone, GitPorts } from "./hostgit.ts";
import { modelFor } from "./models.ts";
import { loadPrompt, renderPrompt } from "./prompts.ts";

/** Where the reviewer writes its Spec findings, inside the sandbox and outside the repository. */
export const FINDINGS_FILE = "/tmp/afk-spec-findings.md";
export const PROTECTED_PREFIX = ".github/workflows/";
export const TAMPERED_REASON = "the agent modified .git configuration or hooks";

/**
 * The environment is not ready (git fetch, docker build or the Docker daemon failed, the kit has no
 * upstream commit, the clean clone could not be fetched). Nothing is wrong with the issue, so runIssue
 * throws it without touching the issue's labels; the daemon (#8) should back off and retry, not relabel.
 */
export class SetupError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SetupError";
  }
}

/**
 * The sandbox cannot be set up for this issue in particular (its branch is checked out elsewhere,
 * it is already claimed on the remote). runIssue marks the issue blocked with this message.
 */
export class IssueSetupError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "IssueSetupError";
  }
}

export interface AgentRun {
  agent: AgentName;
  model: string;
  prompt: string;
  /** Shown in sandcastle's logs, e.g. `afk-7-implementer`. */
  name: string;
}

export interface RunSandbox {
  /** Host path of the worktree on `afk/<id>`. Used to capture git's directories before the agents run, and for nothing else. */
  workdir: string;
  /** Run one agent to completion in the sandbox; rejects when the agent fails. */
  runAgent(run: AgentRun): Promise<void>;
  /** Contents of a file inside the sandbox, or null when it does not exist. */
  readFile(path: string): Promise<string | null>;
  removeFile(path: string): Promise<void>;
  /** Stop the container and remove the worktree. Idempotent. After it, no process of the agents runs. */
  close(): Promise<void>;
}

export interface RunPorts {
  /**
   * Create the worktree on `branch` (forked from `baseRef`, which has just been fetched) and start the
   * sandbox with `env` set. Throws SetupError for an environment problem and IssueSetupError for an
   * issue-specific one; anything else is treated as a SetupError.
   */
  openSandbox(o: { branch: string; baseRef: string; repoDir: string; env: Record<string, string> }): Promise<RunSandbox>;
  git: GitPorts;
  github: {
    /** Open a draft PR in `repo` (`owner/name`) from a neutral directory and return its URL. */
    createDraftPr(o: { cwd: string; repo: string; head: string; base: string; title: string; body: string }): Promise<string>;
    commentOnPr(o: { cwd: string; repo: string; prUrl: string; body: string }): Promise<void>;
  };
  /** File contents, or null when the file does not exist. */
  readText(path: string): string | null;
}

export interface RunInput {
  issue: BacklogIssue;
  config: AfkConfig;
  env: AfkEnv;
  repoDir: string;
  /** Whether origin is on GitHub, which decides whether a PR is opened. */
  github: boolean;
  backlog: Backlog;
  ports: RunPorts;
}

export type RunOutcome =
  /** The branch is pushed. `warning` names every step after the push that failed. */
  | { status: "ready"; branch: string; prUrl?: string; warning?: string }
  /**
   * Nothing was pushed (or, for Backlog.md, only the label swap). `unmarked` is set when the backlog
   * could not record it, which for Backlog.md is always the case before a sandbox exists, because
   * the label swap is a commit on a pushed branch; the caller decides what to do with the issue.
   */
  | { status: "blocked"; reason: string; unmarked?: true };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The issue text is data, fenced in the prompt; it must not be able to write its own closing fence. */
const defence = (text: string) => text.replace(/<\/(untrusted-issue)/gi, "<\\/$1");

const HEX40 = /^[0-9a-f]{40}$/;

export async function runIssue(input: RunInput): Promise<RunOutcome> {
  const { issue, config, env, repoDir, backlog, ports } = input;
  const implementer = issue.agent ?? config.implementer;
  const reviewer = config.reviewer;
  requireSecrets(env, { agents: [implementer, reviewer], github: input.github || config.backlog === "github" });

  const branch = `afk/${issue.id}`;
  const baseRef = `origin/${config.baseBranch}`;
  const isMd = config.backlog === "backlog-md";

  // A block before any sandbox exists. GitHub can label right away; Backlog.md records a block as a
  // commit on a pushed branch, which does not exist yet, so the caller gets the reason unmarked.
  const blockEarly = async (reason: string): Promise<RunOutcome> => {
    if (isMd) return { status: "blocked", reason, unmarked: true };
    await backlog.markBlocked(issue.id, reason);
    return { status: "blocked", reason };
  };

  // Guards that need no sandbox. The base branch is never the target of an AFK run.
  if (!/^[A-Za-z0-9._-]+$/.test(issue.id) || branch === config.baseBranch) {
    return blockEarly(
      branch === config.baseBranch
        ? `the run's branch ${branch} is the base branch; an AFK run never pushes to the base branch`
        : `the issue id ${JSON.stringify(issue.id)} cannot be used in a branch name`,
    );
  }

  const sandboxEnv: Record<string, string> = {};
  for (const agent of new Set([implementer, reviewer])) {
    for (const name of AGENT_TOKEN_VARS[agent]) if (env[name]) sandboxEnv[name] = env[name];
  }

  await ports.git.ensureExcluded(repoDir);
  let sandbox: RunSandbox;
  try {
    sandbox = await ports.openSandbox({ branch, baseRef, repoDir, env: sandboxEnv });
  } catch (e) {
    if (e instanceof IssueSetupError) return blockEarly(e.message);
    throw e instanceof SetupError ? e : new SetupError(`sandbox setup failed: ${message(e)}`, { cause: e });
  }

  let closed = false;
  const stopSandbox = async () => {
    if (closed) return;
    closed = true;
    await sandbox.close();
  };
  // The local worktree and branch are removed at the end unless something stayed unpushed.
  let keepLocal = true;
  let clean: CleanClone | undefined;

  try {
    // I1: before any agent runs, after the host fetch.
    const snap = await ports.git.capture(repoDir, sandbox.workdir, config.baseBranch);
    const cleanClone = async (tip: string | null): Promise<CleanClone> => {
      try {
        return (clean ??= await ports.git.createClean(snap, branch, tip));
      } catch (e) {
        throw e instanceof SetupError ? e : new SetupError(`cannot prepare a clean clone: ${message(e)}`, { cause: e });
      }
    };

    const vars = {
      ISSUE_ID: issue.id,
      ISSUE_TITLE: defence(issue.title),
      ISSUE_URL: issue.url,
      ISSUE_BODY: defence(issue.body),
      BRANCH: branch,
      BASE_BRANCH: config.baseBranch,
      FINDINGS_FILE,
    };
    const phase = async (role: "implementer" | "reviewer", agent: AgentName) =>
      sandbox.runAgent({
        agent,
        model: modelFor(agent, role),
        prompt: renderPrompt(loadPrompt(role === "implementer" ? "implement" : "review", repoDir, ports.readText), vars),
        name: `afk-${issue.id}-${role}`,
      });

    let implementerFailure: string | null = null;
    let reviewNote = "";
    try {
      await phase("implementer", implementer);
    } catch (e) {
      implementerFailure = `the implementer (${implementer}) failed: ${message(e)}`;
    }
    let findings: string | null = null;
    if (implementerFailure === null) {
      try {
        await sandbox.removeFile(FINDINGS_FILE); // nothing an earlier phase left there counts as a finding
        await phase("reviewer", reviewer);
        findings = await sandbox.readFile(FINDINGS_FILE).catch(() => null);
      } catch (e) {
        reviewNote = `Review did not complete: the reviewer (${reviewer}) failed: ${message(e)}`;
      }
    }

    // I2: stop the container before any host-side git step. The user's .git is put back first (the
    // closing of the sandbox runs git in it) and once more after, in case the closing exposed it.
    let tampered = await ports.git.restoreIfTampered(snap);
    await stopSandbox();
    tampered = (await ports.git.restoreIfTampered(snap)) || tampered;

    /**
     * Record that nothing is pushed. GitHub: label and comment. Backlog.md: in the clean clone, on
     * `afk/<id>` at the captured base commit, commit the label swap and push that one commit (the
     * branch keeps the claim). `pushFailed` means the work's own push failed, so there is no branch
     * to record on; the work stays in the local branch and Backlog.md gets no mark.
     */
    const block = async (reason: string, pushFailed = false): Promise<RunOutcome> => {
      let why = reason;
      if (!isMd) {
        await backlog.markBlocked(issue.id, why);
        keepLocal = pushFailed;
        return { status: "blocked", reason: why };
      }
      if (pushFailed) {
        return { status: "blocked", reason: `${why}; the Backlog.md label swap was not recorded, and the work stays in the local branch ${branch}`, unmarked: true };
      }
      try {
        const c = await cleanClone(null);
        await c.checkout(snap.baseSha);
        await backlog.markBlocked(issue.id, why, { workdir: c.dir });
        const head = await c.head();
        const bad = await pushable(c, head, false);
        if (bad !== null) throw new Error(bad);
        await c.push(head);
        keepLocal = false;
        return { status: "blocked", reason: why };
      } catch (e) {
        return { status: "blocked", reason: `${why}; recording the block on ${branch} failed (${message(e)}), so it stays unrecorded`, unmarked: true };
      }
    };

    /** I5: the guards, in the clean clone, on exactly the commit that would be pushed. Null when it may go. */
    const pushable = async (c: CleanClone, sha: string, requireCommits: boolean): Promise<string | null> => {
      let info;
      try {
        info = await c.inspect(sha);
      } catch (e) {
        return `cannot inspect ${sha}: ${message(e)}`;
      }
      if (requireCommits && info.commits === 0) return "the implementer made no commits";
      if (info.merges > 0) return `${branch} contains a merge commit; an AFK run's history must be linear`;
      const touched = info.files.filter((f) => f.startsWith(PROTECTED_PREFIX));
      if (touched.length > 0) return `the branch touches ${PROTECTED_PREFIX}** (${touched.join(", ")}); an AFK run never edits workflows`;
      return null;
    };

    if (tampered) return await block(TAMPERED_REASON);
    if (implementerFailure !== null) return await block(implementerFailure);

    // I3: the one value read from the shared repository.
    let tip: string | null;
    try {
      tip = await ports.git.readTip(snap, branch);
    } catch (e) {
      return await block(`cannot read ${branch}: ${message(e)}`);
    }
    if (tip === null || !HEX40.test(tip)) return await block("the implementer made no commits");

    // I4, I5
    const c = await cleanClone(tip);
    const bad = await pushable(c, tip, true);
    if (bad !== null) return await block(bad);

    try {
      await c.push(tip);
    } catch (e) {
      return await block(`pushing ${branch} failed: ${message(e)}`, true);
    }
    keepLocal = false;

    // From here on nothing throws: the work is on the remote.
    const warnings: string[] = [];
    const attempt = async <T>(step: string, fn: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await fn();
      } catch (e) {
        warnings.push(`${step} failed: ${message(e)}`);
        return undefined;
      }
    };

    const spec = !reviewNote && findings && findings.trim() !== "" ? findings : null;
    let prUrl: string | undefined;
    if (input.github) {
      const repo = githubSlug(snap.originUrl);
      const body = [
        `AFK run for ${issue.url}.`,
        ...(config.backlog === "github" ? [`Closes #${issue.id}`] : []),
        ...(reviewNote ? [reviewNote] : []),
      ].join("\n\n");
      prUrl = repo === null
        ? (warnings.push("opening the draft PR failed: origin is not a GitHub repository URL"), undefined)
        : await attempt("opening the draft PR", () => ports.github.createDraftPr({ cwd: c.dir, repo, head: branch, base: config.baseBranch, title: issue.title, body }));
    }
    if (spec) {
      if (prUrl) await attempt("posting the Spec findings on the PR", () => ports.github.commentOnPr({ cwd: c.dir, repo: githubSlug(snap.originUrl)!, prUrl: prUrl!, body: spec }));
      else await attempt("posting the Spec findings on the issue", () => backlog.comment(issue.id, spec));
    }

    // I6: the label swap is committed in the clean clone (Backlog.md) on top of the pushed tip, checked again, pushed.
    const said = prUrl ? `AFK run finished: ${prUrl}` : `AFK run finished: branch ${branch} is pushed${warnings.length ? ` (${warnings.join("; ")})` : ""}`;
    if (isMd) {
      await attempt("committing the label swap", async () => {
        await c.checkout(tip);
        await backlog.markReadyForHuman(issue.id, said, { workdir: c.dir });
        const finalSha = await c.head();
        const stop = await pushable(c, finalSha, true);
        if (stop !== null) throw new Error(`the label-swap commit was not pushed: ${stop}`);
        await c.push(finalSha);
      });
    } else {
      await attempt("swapping the label", () => backlog.markReadyForHuman(issue.id, said));
    }

    const warning = warnings.length ? `${branch} is pushed, but ${warnings.join("; ")}` : undefined;
    return { status: "ready", branch, ...(prUrl ? { prUrl } : {}), ...(warning ? { warning } : {}) };
  } finally {
    try {
      await stopSandbox();
    } finally {
      await clean?.dispose().catch(() => {});
      if (!keepLocal) await ports.git.removeLocal(repoDir, branch).catch(() => {});
    }
  }
}

