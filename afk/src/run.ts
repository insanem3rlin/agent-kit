// One AFK run: an implementer phase, then a reviewer phase, in one sandbox on one
// branch `afk/<id>`, ending in a pushed branch (a draft PR on GitHub) or a blocked
// issue. The daemon loop (#8) calls runIssue.
//
// Everything that touches Docker, git, gh or the file system sits behind RunPorts
// (src/sandbox.ts and src/hostgit.ts have the real ones), so the orchestration is tested
// with fakes. The agents never talk to GitHub or the backlog and never push: the run does,
// after the guards below have passed. Because an agent can write the repository's .git
// directory, the run checks it against a snapshot before it runs any host git command
// that matters (see hostgit.ts).
import type { Backlog, BacklogIssue } from "./backlog/types.ts";
import type { AfkConfig, AgentName } from "./config.ts";
import { AGENT_TOKEN_VARS, requireSecrets } from "./env.ts";
import type { AfkEnv } from "./env.ts";
import type { GitPorts, GitSnapshot } from "./hostgit.ts";
import { modelFor } from "./models.ts";
import { loadPrompt, renderPrompt } from "./prompts.ts";

/** Where the reviewer writes its Spec findings, inside the sandbox and outside the repository. */
export const FINDINGS_FILE = "/tmp/afk-spec-findings.md";
export const PROTECTED_PREFIX = ".github/workflows/";
export const TAMPERED_REASON = "the agent modified .git configuration or hooks";

/**
 * The environment is not ready (git fetch, docker build or the Docker daemon failed, the kit has no
 * upstream commit). Nothing is wrong with the issue, so runIssue throws it without touching the
 * issue's labels; the daemon (#8) should back off and retry, not relabel.
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
  /** Host path of the worktree on `afk/<id>`. */
  workdir: string;
  /** Run one agent to completion in the sandbox; rejects when the agent fails. */
  runAgent(run: AgentRun): Promise<void>;
  /** Contents of a file inside the sandbox, or null when it does not exist. */
  readFile(path: string): Promise<string | null>;
  removeFile(path: string): Promise<void>;
  close(): Promise<void>;
}

export interface RunPorts {
  /**
   * Create the worktree on `branch` (forked from `baseRef`) and start the sandbox with `env` set.
   * Throws SetupError for an environment problem and IssueSetupError for an issue-specific one;
   * anything else is treated as a SetupError.
   */
  openSandbox(o: { branch: string; baseRef: string; repoDir: string; env: Record<string, string> }): Promise<RunSandbox>;
  git: GitPorts;
  github: {
    /** Open a draft PR and return its URL. */
    createDraftPr(o: { repoDir: string; head: string; base: string; title: string; body: string }): Promise<string>;
    commentOnPr(repoDir: string, prUrl: string, body: string): Promise<void>;
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
  | { status: "ready"; branch: string; prUrl?: string; warning?: string }
  | { status: "blocked"; reason: string };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The issue text is data, fenced in the prompt; it must not be able to write its own closing fence. */
const defence = (text: string) => text.replace(/<\/(untrusted-issue)/gi, "<\\/$1");

export async function runIssue(input: RunInput): Promise<RunOutcome> {
  const { issue, config, env, repoDir, backlog, ports } = input;
  const implementer = issue.agent ?? config.implementer;
  const reviewer = config.reviewer;
  requireSecrets(env, { agents: [implementer, reviewer], github: input.github || config.backlog === "github" });

  const branch = `afk/${issue.id}`;
  const baseRef = `origin/${config.baseBranch}`;

  // Guards that need no sandbox. The base branch is never the target of an AFK run.
  if (!/^[A-Za-z0-9._-]+$/.test(issue.id) || branch === config.baseBranch) {
    const why = branch === config.baseBranch
      ? `the run's branch ${branch} is the base branch; an AFK run never pushes to the base branch`
      : `the issue id ${JSON.stringify(issue.id)} cannot be used in a branch name`;
    await backlog.markBlocked(issue.id, why);
    return { status: "blocked", reason: why };
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
    if (e instanceof IssueSetupError) {
      await backlog.markBlocked(issue.id, e.message);
      return { status: "blocked", reason: e.message };
    }
    throw e instanceof SetupError ? e : new SetupError(`sandbox setup failed: ${message(e)}`, { cause: e });
  }
  const workdir = sandbox.workdir;
  const pushesBlockedBranch = config.backlog === "backlog-md";
  // The local worktree and branch are removed at the end unless something stayed unpushed.
  let keepLocal = true;

  // Push `branch` as it is now. Returns an error message, or null on success. Never throws.
  const pushCurrent = async (snap: GitSnapshot): Promise<string | null> => {
    try {
      const r = await ports.git.resolve(workdir, branch, baseRef);
      if ("error" in r) return r.error;
      await ports.git.push(workdir, snap, branch, r.tip);
      return null;
    } catch (e) {
      return message(e);
    }
  };

  try {
    const snap = await ports.git.snapshot(workdir);

    // Nothing is pushed: drop whatever the agents committed, record the reason, and for Backlog.md
    // push the branch holding only the label-swap commit (the branch keeps the claim). When the push of
    // the work itself failed (`pushFailed`), the work stays local and nothing is pushed a second time.
    // A failed push of the label swap is reported in the reason; this never throws for a push.
    const block = async (reason: string, pushFailed = false): Promise<RunOutcome> => {
      if (!pushFailed) await ports.git.resetBranch(workdir, branch, baseRef);
      let why = reason;
      if (pushesBlockedBranch && pushFailed) why += `; the label-swap commit stays local on ${branch}`;
      await backlog.markBlocked(issue.id, why, { workdir });
      if (pushFailed) {
        keepLocal = true;
      } else if (pushesBlockedBranch) {
        const failed = await pushCurrent(snap);
        if (failed !== null) why += `; pushing the label swap failed (${failed}), so it stays local on ${branch}`;
        else keepLocal = false;
      } else {
        keepLocal = false;
      }
      return { status: "blocked", reason: why };
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
    if (implementerFailure === null) {
      try {
        await sandbox.removeFile(FINDINGS_FILE); // nothing an earlier phase left there counts as a finding
        await phase("reviewer", reviewer);
      } catch (e) {
        reviewNote = `Review did not complete: the reviewer (${reviewer}) failed: ${message(e)}`;
      }
    }

    // Before any other host git command: the agents could write .git while they ran.
    if (await ports.git.restoreIfTampered(workdir, snap)) return await block(TAMPERED_REASON);
    if (implementerFailure !== null) return await block(implementerFailure);

    const resolved = await ports.git.resolve(workdir, branch, baseRef);
    if ("error" in resolved) return await block(`cannot push ${branch}: ${resolved.error}`);
    const { base, tip } = resolved;
    const changes = await ports.git.inspect(workdir, base, tip);
    if (changes.commits === 0) return await block("the implementer made no commits");
    if (changes.merges > 0) return await block(`${branch} contains a merge commit; an AFK run's history must be linear`);
    const touched = changes.files.filter((f) => f.startsWith(PROTECTED_PREFIX));
    if (touched.length > 0) {
      return await block(`the branch touches ${PROTECTED_PREFIX}** (${touched.join(", ")}); an AFK run never edits workflows`);
    }

    try {
      await ports.git.push(workdir, snap, branch, tip);
    } catch (e) {
      return await block(`pushing ${branch} failed: ${message(e)}`, true);
    }
    keepLocal = false;

    const findings = reviewNote ? null : await sandbox.readFile(FINDINGS_FILE);
    const spec = findings && findings.trim() !== "" ? findings : null;

    let prUrl: string | undefined;
    if (input.github) {
      const body = [
        `AFK run for ${issue.url}.`,
        ...(config.backlog === "github" ? [`Closes #${issue.id}`] : []),
        ...(reviewNote ? [reviewNote] : []),
      ].join("\n\n");
      prUrl = await ports.github.createDraftPr({ repoDir, head: branch, base: config.baseBranch, title: issue.title, body });
    }
    if (spec) {
      if (prUrl) await ports.github.commentOnPr(repoDir, prUrl, spec);
      else await backlog.comment(issue.id, spec);
    }

    await backlog.markReadyForHuman(issue.id, prUrl ? `AFK run finished: ${prUrl}` : `AFK run finished: branch ${branch} is pushed`, { workdir });
    let warning: string | undefined;
    if (pushesBlockedBranch) {
      const failed = await pushCurrent(snap);
      if (failed !== null) {
        warning = `the label swap commit is not pushed (${failed}); it stays local on ${branch}`;
        keepLocal = true;
      }
    }
    return { status: "ready", branch, ...(prUrl ? { prUrl } : {}), ...(warning ? { warning } : {}) };
  } finally {
    try {
      await sandbox.close();
    } finally {
      if (!keepLocal) await ports.git.removeLocal(repoDir, branch).catch(() => {});
    }
  }
}
