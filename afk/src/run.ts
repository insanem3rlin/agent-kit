// One AFK run: an implementer phase, then a reviewer phase, in one sandbox on one
// branch `afk/<id>`, ending in a pushed branch (a draft PR on GitHub) or a blocked
// issue. The daemon loop (#8) calls runIssue.
//
// Everything that touches Docker, git, gh or the file system sits behind RunPorts
// (src/sandbox.ts has the real ones), so the orchestration is tested with fakes.
// The agents never talk to GitHub or the backlog and never push: the run does,
// after the guards below have passed.
import type { Backlog, BacklogIssue } from "./backlog/types.ts";
import type { AfkConfig, AgentName } from "./config.ts";
import { AGENT_TOKEN_VARS, requireSecrets } from "./env.ts";
import type { AfkEnv } from "./env.ts";
import { modelFor } from "./models.ts";
import { loadPrompt, renderPrompt } from "./prompts.ts";

/** Where the reviewer writes its Spec findings, inside the sandbox and outside the repository. */
export const FINDINGS_FILE = "/tmp/afk-spec-findings.md";
export const PROTECTED_PREFIX = ".github/workflows/";

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
  close(): Promise<void>;
}

export interface RunPorts {
  /** Create the worktree on `branch` (forked from `baseRef`) and start the sandbox with `env` set. */
  openSandbox(o: { branch: string; baseRef: string; repoDir: string; env: Record<string, string> }): Promise<RunSandbox>;
  git: {
    commitCount(workdir: string, baseRef: string): Promise<number>;
    /** Paths touched by any commit in `baseRef..HEAD`, renames counted as delete plus add. */
    changedFiles(workdir: string, baseRef: string): Promise<string[]>;
    resetTo(workdir: string, baseRef: string): Promise<void>;
    /** Plain push of `branch` to origin; never forced. */
    push(workdir: string, branch: string): Promise<void>;
  };
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
  | { status: "ready"; branch: string; prUrl?: string }
  | { status: "blocked"; reason: string };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

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

  const sandbox = await ports.openSandbox({ branch, baseRef, repoDir, env: sandboxEnv });
  const workdir = sandbox.workdir;
  const pushesBlockedBranch = config.backlog === "backlog-md";

  // Nothing is pushed: drop whatever the agents committed, record the reason, and for Backlog.md
  // push the branch holding only the label-swap commit (the branch keeps the claim).
  const block = async (reason: string): Promise<RunOutcome> => {
    await ports.git.resetTo(workdir, baseRef);
    await backlog.markBlocked(issue.id, reason, { workdir });
    if (pushesBlockedBranch) await ports.git.push(workdir, branch);
    return { status: "blocked", reason };
  };

  try {
    const vars = {
      ISSUE_ID: issue.id,
      ISSUE_TITLE: issue.title,
      ISSUE_URL: issue.url,
      ISSUE_BODY: issue.body,
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

    try {
      await phase("implementer", implementer);
    } catch (e) {
      return await block(`the implementer (${implementer}) failed: ${message(e)}`);
    }

    let reviewNote = "";
    try {
      await phase("reviewer", reviewer);
    } catch (e) {
      reviewNote = `Review did not complete: the reviewer (${reviewer}) failed: ${message(e)}`;
    }

    if ((await ports.git.commitCount(workdir, baseRef)) === 0) {
      return await block("the implementer made no commits");
    }
    const touched = (await ports.git.changedFiles(workdir, baseRef)).filter((f) => f.startsWith(PROTECTED_PREFIX));
    if (touched.length > 0) {
      return await block(`the branch touches ${PROTECTED_PREFIX}** (${touched.join(", ")}); an AFK run never edits workflows`);
    }

    try {
      await ports.git.push(workdir, branch);
    } catch (e) {
      return await block(`pushing ${branch} failed: ${message(e)}`);
    }

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
    if (pushesBlockedBranch) await ports.git.push(workdir, branch);
    return prUrl ? { status: "ready", branch, prUrl } : { status: "ready", branch };
  } finally {
    await sandbox.close();
  }
}
