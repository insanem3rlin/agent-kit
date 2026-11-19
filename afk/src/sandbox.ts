// The real RunPorts: sandcastle with its Docker provider for the sandbox and the
// worktree, git and gh for everything the run does on the host. None of it runs in
// the test suite (no Docker, no network); the pure argument builders are tested.
// sandcastle is imported lazily so the tests need no installed dependencies.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR } from "./config.ts";
import type { AgentName } from "./config.ts";
import type { AfkEnv } from "./env.ts";
import type { AgentRun, RunPorts, RunSandbox } from "./run.ts";

/** The kit checkout this engine runs from; its HEAD is what the sandbox image installs. */
export const KIT_DIR = fileURLToPath(new URL("../../", import.meta.url));

interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
}

function exec(command: string, args: string[], o: ExecOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      { cwd: o.cwd, env: o.env ?? process.env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`${command} ${args.slice(0, 2).join(" ")} failed: ${(stderr || err.message).trim()}`));
        else resolve(stdout);
      },
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(o.input ?? "");
  });
}

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

/** `git push` that authenticates through gh with GH_TOKEN, never forces and names exactly one ref. */
export function pushArgs(branch: string): string[] {
  return [
    "-c", "credential.helper=",
    "-c", "credential.helper=!gh auth git-credential",
    "push", "--set-upstream", "origin", `refs/heads/${branch}:refs/heads/${branch}`,
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

export function createPorts(afkEnv: AfkEnv): RunPorts {
  const hostEnv = { ...process.env, ...(afkEnv.GH_TOKEN ? { GH_TOKEN: afkEnv.GH_TOKEN } : {}) };
  return {
    async openSandbox({ branch, baseRef, repoDir, env }): Promise<RunSandbox> {
      const sandcastle = await import("@ai-hero/sandcastle");
      const { docker } = await import("@ai-hero/sandcastle/sandboxes/docker");
      const imageName = imageNameFor(repoDir);
      const kitRef = (await exec("git", ["-C", KIT_DIR, "rev-parse", "HEAD"])).trim();
      const uid = process.getuid?.() ?? 1000;
      const gid = process.getgid?.() ?? 1000;
      await exec("git", ["fetch", "origin", baseRef.replace(/^origin\//, "")], { cwd: repoDir, env: hostEnv });
      await exec("docker", dockerBuildArgs({ imageName, repoDir, kitRef, uid, gid }));
      const sandbox = await sandcastle.createSandbox({
        branch,
        baseBranch: baseRef,
        cwd: repoDir,
        sandbox: docker({ imageName, containerUid: uid, containerGid: gid, env }),
      });
      return {
        workdir: sandbox.worktreePath,
        async runAgent(run: AgentRun) {
          await sandbox.run({ agent: agentProvider(sandcastle, run.agent, run.model), prompt: run.prompt, name: run.name });
        },
        async readFile(path) {
          const r = await sandbox.exec(`cat ${JSON.stringify(path)}`);
          return r.exitCode === 0 ? r.stdout : null;
        },
        async close() {
          await sandbox.close();
        },
      };
    },
    git: {
      async commitCount(workdir, baseRef) {
        return Number((await exec("git", ["rev-list", "--count", `${baseRef}..HEAD`], { cwd: workdir })).trim());
      },
      async changedFiles(workdir, baseRef) {
        const out = await exec("git", ["log", "--no-renames", "--name-only", "--format=", `${baseRef}..HEAD`], { cwd: workdir });
        return [...new Set(out.split("\n").map((l) => l.trim()).filter(Boolean))];
      },
      async resetTo(workdir, baseRef) {
        await exec("git", ["reset", "--hard", baseRef], { cwd: workdir });
      },
      async push(workdir, branch) {
        await exec("git", pushArgs(branch), { cwd: workdir, env: { ...hostEnv, GIT_TERMINAL_PROMPT: "0" } });
      },
    },
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
