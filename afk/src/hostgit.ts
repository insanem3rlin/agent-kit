// Everything the run does with git on the host, after an agent has had write access to
// the repository's .git directory.
//
// sandcastle bind-mounts the host repo's .git writable, so an agent can plant hooks or
// change .git/config (core.fsmonitor, core.sshCommand, credential.helper, url.*.insteadOf,
// include.path) and have the host execute that code on the next git command, with
// GH_TOKEN in its environment. Three defences, all here:
//   1. snapshot() records the config files, the hooks directory and the origin URL after
//      the sandbox is up and before any agent runs; restoreIfTampered() compares and puts
//      everything back, and the run blocks the issue when it had to.
//   2. Every host git command runs with core.hooksPath pointing at an empty directory
//      and core.fsmonitor=false, so nothing planted can run even if a check were missed.
//   3. The push goes to the origin URL captured in the snapshot and names one commit,
//      the exact sha the guards inspected.
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { isGithubUrl } from "./git.ts";

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
}

export function exec(command: string, args: string[], o: ExecOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      { cwd: o.cwd, env: o.env ?? process.env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: o.timeoutMs },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`${command} ${args.filter((a) => !a.startsWith("-") && !a.includes("=")).slice(0, 2).join(" ")} failed: ${(stderr || err.message).trim()}`));
        else resolve(stdout);
      },
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(o.input ?? "");
  });
}

/** The environment of every host git command: it never prompts, whatever the remote asks for. */
export function gitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const ownSsh = base.GIT_SSH_COMMAND || base.GIT_SSH;
  return { ...base, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", ...(ownSsh ? {} : { GIT_SSH_COMMAND: "ssh -o BatchMode=yes" }) };
}

let emptyHooks: string | undefined;
function emptyHooksDir(): string {
  emptyHooks ??= mkdtempSync(join(tmpdir(), "afk-nohooks-"));
  return emptyHooks.replaceAll("\\", "/");
}

/** `-c` options that stop planted hooks and fsmonitor commands from running. */
function hardening(): string[] {
  return ["-c", `core.hooksPath=${emptyHooksDir()}`, "-c", "core.fsmonitor=false"];
}

/** Arguments of the push: one commit to one ref of the captured URL, never forced. */
export function pushArgs(url: string, branch: string, tip: string): string[] {
  return [
    ...hardening(),
    ...(isGithubUrl(url) ? ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"] : []),
    "push", url, `${tip}:refs/heads/${branch}`,
  ];
}

interface FileState {
  /** null for a directory */
  content: Buffer | null;
  mode: number;
}

export interface GitSnapshot {
  commonDir: string;
  gitDir: string;
  originUrl: string;
  /** Config files and info/attributes, by absolute path; null when absent. */
  files: Record<string, FileState | null>;
  /** The settings in each config file that matter for tampering. */
  entries: Record<string, string[]>;
  hooks: Record<string, FileState>;
}

export interface GitPorts {
  /** Make sure `.sandcastle/` is in `.git/info/exclude`, so sandcastle's worktrees and logs never show as untracked. */
  ensureExcluded(repoDir: string): Promise<void>;
  snapshot(workdir: string): Promise<GitSnapshot>;
  /** Compare .git with the snapshot; when it differs, restore it and return true. */
  restoreIfTampered(workdir: string, snap: GitSnapshot): Promise<boolean>;
  /** The shas of `origin/<base>` and of `afk/<id>`, provided HEAD is on that branch. */
  resolve(workdir: string, branch: string, baseRef: string): Promise<{ base: string; tip: string } | { error: string }>;
  /** What pushing `tip` would add on top of `base`. */
  inspect(workdir: string, base: string, tip: string): Promise<{ commits: number; merges: number; files: string[] }>;
  /** Point the named branch at `baseRef` and check it out, from whatever state HEAD is in. */
  resetBranch(workdir: string, branch: string, baseRef: string): Promise<void>;
  /** Push exactly `tip` to `refs/heads/<branch>` of the origin URL in the snapshot. */
  push(workdir: string, snap: GitSnapshot, branch: string, tip: string): Promise<void>;
  /** Remove the branch's worktree and the local branch. */
  removeLocal(repoDir: string, branch: string): Promise<void>;
}

// Settings sandcastle itself writes inside the sandbox; they cannot run anything.
const BENIGN = new Set(["user.name", "user.email", "safe.directory"]);

function readState(path: string): FileState | null {
  try {
    const st = statSync(path);
    return { content: st.isDirectory() ? null : readFileSync(path), mode: st.mode & 0o777 };
  } catch {
    return null;
  }
}

function readHooks(dir: string): Record<string, FileState> {
  const out: Record<string, FileState> = {};
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const st = readState(join(dir, name));
    if (st) out[name] = st;
  }
  return out;
}

const same = (a: FileState | null | undefined, b: FileState | null | undefined) =>
  a == null || b == null ? a == b : a.content === null || b.content === null ? a.content === b.content : a.content.equals(b.content);

export function createGitPorts(baseEnv: NodeJS.ProcessEnv = process.env): GitPorts {
  const env = gitEnv(baseEnv);
  const hg = (cwd: string, args: string[]) => exec("git", [...hardening(), ...args], { cwd, env });

  async function configEntries(path: string): Promise<string[]> {
    if (!existsSync(path)) return [];
    const out = await hg(dirname(path), ["config", "--file", path, "--list", "-z"]);
    return out.split("\0").filter((e) => e !== "" && !BENIGN.has(e.split("\n")[0].toLowerCase())).sort();
  }

  async function dirs(workdir: string) {
    return {
      commonDir: (await hg(workdir, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim(),
      gitDir: (await hg(workdir, ["rev-parse", "--absolute-git-dir"])).trim(),
    };
  }

  const guarded = (d: { commonDir: string; gitDir: string }) => ({
    configs: [join(d.commonDir, "config"), join(d.gitDir, "config.worktree")],
    attributes: [join(d.commonDir, "info", "attributes"), join(d.gitDir, "info", "attributes")],
  });

  return {
    async ensureExcluded(repoDir) {
      const rel = (await hg(repoDir, ["rev-parse", "--git-path", "info/exclude"])).trim();
      const path = isAbsolute(rel) ? rel : join(repoDir, rel);
      let text = "";
      try {
        text = readFileSync(path, "utf8");
      } catch {
        mkdirSync(dirname(path), { recursive: true });
      }
      if (text.split(/\r?\n/).includes(".sandcastle/")) return;
      writeFileSync(path, `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}.sandcastle/\n`);
    },

    async snapshot(workdir) {
      const d = await dirs(workdir);
      const g = guarded(d);
      const files: GitSnapshot["files"] = {};
      const entries: GitSnapshot["entries"] = {};
      for (const p of [...g.configs, ...g.attributes]) files[p] = readState(p);
      for (const p of g.configs) entries[p] = await configEntries(p);
      const originUrl = (await hg(workdir, ["config", "--get", "remote.origin.url"])).trim();
      return { ...d, originUrl, files, entries, hooks: readHooks(join(d.commonDir, "hooks")) };
    },

    async restoreIfTampered(workdir, snap) {
      void workdir;
      let tampered = false;
      for (const [path, before] of Object.entries(snap.files)) {
        const now = readState(path);
        let changed = !same(before, now);
        if (changed && path in snap.entries) {
          // Compare what the file means, so sandcastle's own `git config user.name` is not tampering.
          changed = JSON.stringify(await configEntries(path)) !== JSON.stringify(snap.entries[path]);
        }
        if (!changed) continue;
        tampered = true;
        if (before === null) rmSync(path, { force: true, recursive: true });
        else {
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, before.content ?? "");
          chmodSync(path, before.mode);
        }
      }
      const hooksDir = join(snap.commonDir, "hooks");
      const now = readHooks(hooksDir);
      for (const name of Object.keys(now)) {
        if (!(name in snap.hooks)) {
          tampered = true;
          rmSync(join(hooksDir, name), { force: true, recursive: true });
        }
      }
      for (const [name, before] of Object.entries(snap.hooks)) {
        if (same(before, now[name])) continue;
        tampered = true;
        const path = join(hooksDir, name);
        rmSync(path, { force: true, recursive: true });
        if (before.content === null) mkdirSync(path, { recursive: true });
        else {
          mkdirSync(hooksDir, { recursive: true });
          writeFileSync(path, before.content);
          chmodSync(path, before.mode);
        }
      }
      return tampered;
    },

    async resolve(workdir, branch, baseRef) {
      const ref = `refs/heads/${branch}`;
      const head = await hg(workdir, ["symbolic-ref", "-q", "HEAD"]).then((s) => s.trim(), () => null);
      if (head !== ref) return { error: `HEAD is ${head === null ? "detached" : head}, not ${ref}` };
      try {
        const tip = (await hg(workdir, ["rev-parse", "--verify", `${ref}^{commit}`])).trim();
        const base = (await hg(workdir, ["rev-parse", "--verify", `${baseRef}^{commit}`])).trim();
        return { base, tip };
      } catch (e) {
        return { error: (e as Error).message };
      }
    },

    async inspect(workdir, base, tip) {
      const mergeBase = (await hg(workdir, ["merge-base", base, tip])).trim();
      const range = `${base}..${tip}`;
      const commits = Number((await hg(workdir, ["rev-list", "--count", range])).trim());
      const merges = Number((await hg(workdir, ["rev-list", "--merges", "--count", range])).trim());
      // The net tree change catches what a merge commit adds; the per-commit paths catch a file that
      // was added and removed again. Both are pushed, so both are checked.
      const tree = await hg(workdir, ["diff", "--name-only", "--no-renames", "-z", mergeBase, tip]);
      const log = await hg(workdir, ["log", "--no-merges", "--no-renames", "--name-only", "--format=", "-z", range]);
      const files = new Set([...tree.split("\0"), ...log.split("\0")].filter((f) => f !== ""));
      return { commits, merges, files: [...files] };
    },

    async resetBranch(workdir, branch, baseRef) {
      await hg(workdir, ["checkout", "--force", "-B", branch, baseRef]);
    },

    async push(workdir, snap, branch, tip) {
      await exec("git", pushArgs(snap.originUrl, branch, tip), { cwd: workdir, env });
    },

    async removeLocal(repoDir, branch) {
      await removeStale(repoDir, branch, env);
    },
  };
}

/** Remove the worktree that has `branch` checked out, if any, then the local branch. Idempotent. */
export async function removeStale(repoDir: string, branch: string, env: NodeJS.ProcessEnv = gitEnv()): Promise<void> {
  const hg = (args: string[]) => exec("git", [...hardening(), ...args], { cwd: repoDir, env });
  const blocks = (await hg(["worktree", "list", "--porcelain"])).split(/\r?\n\r?\n/).filter(Boolean);
  const ref = `refs/heads/${branch}`;
  for (const [i, block] of blocks.entries()) {
    const lines = block.split(/\r?\n/);
    const path = lines.find((l) => l.startsWith("worktree "))?.slice("worktree ".length);
    if (!path || !lines.includes(`branch ${ref}`)) continue;
    if (i === 0) throw new Error(`${ref} is checked out in the main working tree at ${path}`);
    await hg(["worktree", "remove", "--force", "--force", path]);
  }
  await hg(["worktree", "prune"]);
  const exists = await hg(["show-ref", "--verify", "--quiet", ref]).then(() => true, () => false);
  if (exists) await hg(["branch", "-D", branch]);
}

/** Whether `refs/heads/<branch>` exists on origin, which is what a claim is. Rejects when origin is unreachable. */
export async function remoteHasBranch(repoDir: string, branch: string, env: NodeJS.ProcessEnv = gitEnv()): Promise<boolean> {
  const out = await exec("git", [...hardening(), "ls-remote", "--heads", "origin", `refs/heads/${branch}`], { cwd: repoDir, env, timeoutMs: 60_000 });
  return out.trim() !== "";
}
