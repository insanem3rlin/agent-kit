// The real RunPorts: sandcastle with its Docker provider for the sandbox and the
// worktree, git and gh for everything the run does on the host. None of it runs in
// the test suite (no Docker, no network); the pure argument builders are tested.
// sandcastle is imported lazily so the tests need no installed dependencies.
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR } from "./config.ts";
import type { AgentName } from "./config.ts";
import type { AfkEnv } from "./env.ts";
import { createGitPorts, exec, gitEnv, remoteHasBranch, removeStale } from "./hostgit.ts";
import { IssueSetupError, SetupError } from "./run.ts";
import type { AgentRun, RunPorts, RunSandbox } from "./run.ts";

/** The kit checkout this engine runs from. The sandbox image installs its newest commit that the remote has (kitCommit). */
export const KIT_DIR = fileURLToPath(new URL("../../", import.meta.url));

/** Docker image tag for a repository: `afk-<directory name>`, restricted to what a tag allows. */
export function imageNameFor(repoDir: string): string {
  const safe = basename(repoDir).toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^[-.]+/, "");
  return `afk-${safe || "repo"}`;
}

/** `docker build` arguments; `kitRef` busts the image's kit layer whenever the kit's commit changes. */
export function dockerBuildArgs(o: { imageName: string; repoDir: string; kitRef: string; uid: number; gid: number }): string[] {
  return [
    "build",
    "--tag", o.imageName,
    "--build-arg", `AGENT_KIT_REF=${o.kitRef}`,
    "--build-arg", `AGENT_UID=${o.uid}`,
    "--build-arg", `AGENT_GID=${o.gid}`,
    "--file", join(o.repoDir, CONFIG_DIR, "Dockerfile"),
    join(o.repoDir, CONFIG_DIR),
  ];
}

export function draftPrArgs(o: { head: string; base: string; title: string }): string[] {
  return ["pr", "create", "--draft", "--head", o.head, "--base", o.base, "--title", o.title, "--body-file", "-"];
}

function agentProvider(sandcastle: typeof import("@ai-hero/sandcastle"), agent: AgentName, model: string) {
  switch (agent) {
    case "claude":
      return sandcastle.claudeCode(model);
    case "codex":
      return sandcastle.codex(model);
    case "cursor":
      return sandcastle.cursor(model);
  }
}

/**
 * The kit commit the sandbox image installs: one that exists on the kit's remote, because the
 * Dockerfile clones it from there. That is the merge-base of the local HEAD and its upstream, which
 * is the upstream commit itself when HEAD is level with it. Local commits the remote lacks are not
 * in the image; `log` says so.
 */
export async function kitCommit(kitDir: string, log: (line: string) => void = () => {}): Promise<string> {
  const git = (...args: string[]) => exec("git", ["-C", kitDir, ...args], { env: gitEnv() }).then((s) => s.trim());
  try {
    const head = await git("rev-parse", "HEAD");
    const commit = await git("merge-base", "HEAD", "@{upstream}");
    if (commit !== head) log(`afk: the kit checkout is at ${head.slice(0, 12)}, but the sandbox image installs ${commit.slice(0, 12)}, the newest commit its upstream has`);
    return commit;
  } catch (e) {
    throw new SetupError(`cannot tell which kit commit the sandbox image should install (does ${kitDir} track an upstream branch?): ${(e as Error).message}`, { cause: e });
  }
}

const ISSUE_SPECIFIC = /already (?:checked out|exists|used by worktree)|is already|worktree/i;

export function createPorts(afkEnv: AfkEnv, log: (line: string) => void = (l) => console.error(l)): RunPorts {
  const hostEnv = gitEnv({ ...process.env, ...(afkEnv.GH_TOKEN ? { GH_TOKEN: afkEnv.GH_TOKEN } : {}) });
  return {
    async openSandbox({ branch, baseRef, repoDir, env }): Promise<RunSandbox> {
      const baseBranch = baseRef.replace(/^origin\//, "");
      // Environment first: a failure here says nothing about the issue.
      let kitRef: string;
      const imageName = imageNameFor(repoDir);
      const uid = process.getuid?.() ?? 1000;
      const gid = process.getgid?.() ?? 1000;
      try {
        await exec("git", ["fetch", "origin", baseBranch], { cwd: repoDir, env: hostEnv, timeoutMs: 120_000 });
        kitRef = await kitCommit(KIT_DIR, log);
        await exec("docker", dockerBuildArgs({ imageName, repoDir, kitRef, uid, gid }));
      } catch (e) {
        throw e instanceof SetupError ? e : new SetupError(`sandbox environment is not ready: ${(e as Error).message}`, { cause: e });
      }

      // Then the issue. The daemon only starts unclaimed issues, so a claim on the remote means someone
      // else owns the branch. Anything local left from an earlier run is stale: sandcastle ignores the
      // base ref when the branch already exists, so it would resume the old work.
      let claimed: boolean;
      try {
        claimed = await remoteHasBranch(repoDir, branch, hostEnv);
      } catch (e) {
        throw new SetupError(`cannot reach origin to check for a claim: ${(e as Error).message}`, { cause: e });
      }
      if (claimed) throw new IssueSetupError(`${branch} already exists on the remote, so the issue is claimed`);
      try {
        await removeStale(repoDir, branch, hostEnv);
      } catch (e) {
        throw new IssueSetupError(`cannot clear the leftover local ${branch}: ${(e as Error).message}`, { cause: e });
      }

      const sandcastle = await import("@ai-hero/sandcastle");
      const { docker } = await import("@ai-hero/sandcastle/sandboxes/docker");
      let sandbox: Awaited<ReturnType<typeof sandcastle.createSandbox>>;
      try {
        sandbox = await sandcastle.createSandbox({
          branch,
          baseBranch: baseRef,
          cwd: repoDir,
          sandbox: docker({ imageName, containerUid: uid, containerGid: gid, env }),
        });
      } catch (e) {
        const msg = (e as Error).message;
        throw ISSUE_SPECIFIC.test(msg) ? new IssueSetupError(`cannot create the worktree for ${branch}: ${msg}`, { cause: e }) : new SetupError(`cannot start the sandbox: ${msg}`, { cause: e });
      }
      return {
        workdir: sandbox.worktreePath,
        async runAgent(run: AgentRun) {
          await sandbox.run({ agent: agentProvider(sandcastle, run.agent, run.model), prompt: run.prompt, name: run.name });
        },
        async readFile(path) {
          const r = await sandbox.exec(`cat ${JSON.stringify(path)}`);
          return r.exitCode === 0 ? r.stdout : null;
        },
        async removeFile(path) {
          await sandbox.exec(`rm -f ${JSON.stringify(path)}`);
        },
        async close() {
          await sandbox.close();
        },
      };
    },
    git: createGitPorts(hostEnv),
    github: {
      async createDraftPr({ repoDir, head, base, title, body }) {
        const out = await exec("gh", draftPrArgs({ head, base, title }), { cwd: repoDir, env: hostEnv, input: body });
        return out.trim().split("\n").at(-1) ?? "";
      },
      async commentOnPr(repoDir, prUrl, body) {
        await exec("gh", ["pr", "comment", prUrl, "--body-file", "-"], { cwd: repoDir, env: hostEnv, input: body });
      },
    },
    readText(path) {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
  };
}
