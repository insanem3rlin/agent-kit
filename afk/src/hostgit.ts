// Everything the run does with git on the host around an agent that had write access to
// the repository's shared `.git`.
//
// The boundary. sandcastle bind-mounts the host repo's `.git` writable into the container,
// so after an agent ran nothing in that directory can be trusted: not its config, hooks,
// refs, replace refs, packed-refs, nor the `commondir` / `gitdir` files that tell git which
// repository a worktree belongs to (rewrite those and a git command run in the worktree
// reads an attacker's repository and config instead). So the run never asks the shared
// repository to do anything after the agents ran. It does this instead:
//   1. Before any agent runs, capture() records what the run needs: the base commit
//      (`origin/<base>`), the origin URL and the real git directories.
//   2. After the agents (and with the container stopped), readTip() reads the one value the
//      run needs from the shared repository, the tip of `refs/heads/afk/<id>`, straight from
//      the ref files without running git, and validates it as a 40-character hex id.
//   3. createClean() makes a fresh clone in the temp directory that no agent touched. It
//      fetches the base history from the captured URL and copies the agent's objects out of
//      the shared object directory (as an alternate: objects only, no config, hooks or refs
//      are consulted), re-hashed and fsck-checked by `index-pack --strict`.
//   4. Every guard, the label-swap commit of the Backlog.md backlog and the push happen in
//      that clean clone, against the captured base commit and the validated tip, with
//      replace refs off, hooks off and fsmonitor off.
// The snapshot and restore of the user's own `.git` (restoreIfTampered) is only there to
// protect the user's repository for later; nothing the run does depends on it. It covers the
// config files, `config.worktree`, the `commondir` / `gitdir` files, `info/attributes` and the
// hooks directory. It does not cover files a config `include`s, `.git/modules`, or residue
// from a crash in the middle of a run.
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { isGithubUrl } from "./git.ts";

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string | Buffer;
  timeoutMs?: number;
}

function execRaw(command: string, args: string[], o: ExecOptions = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      { cwd: o.cwd, env: o.env ?? process.env, encoding: "buffer", maxBuffer: 1024 * 1024 * 1024, windowsHide: true, timeout: o.timeoutMs },
      (err, stdout, stderr) => {
        if (err) {
          const what = args.filter((a) => !a.startsWith("-") && !a.includes("=")).slice(0, 2).join(" ");
          reject(new Error(`${command} ${what} failed: ${(stderr.toString("utf8") || err.message).trim()}`));
        } else resolve(stdout);
      },
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(o.input ?? "");
  });
}

export async function exec(command: string, args: string[], o: ExecOptions = {}): Promise<string> {
  return (await execRaw(command, args, o)).toString("utf8");
}

/** The environment of every host git command: it never prompts, whatever the remote asks for. */
export function gitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  // Nothing in the caller's environment may redirect git to another repository or object store.
  for (const k of ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE"]) delete env[k];
  const ownSsh = env.GIT_SSH_COMMAND || env.GIT_SSH;
  return { ...env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", ...(ownSsh ? {} : { GIT_SSH_COMMAND: "ssh -o BatchMode=yes" }) };
}

let emptyHooks: string | undefined;
function emptyHooksDir(): string {
  emptyHooks ??= mkdtempSync(join(tmpdir(), "afk-nohooks-"));
  return emptyHooks.replaceAll("\\", "/");
}

/** `-c` options that stop planted hooks, fsmonitor commands and the `ext::` transport from running. */
function hardening(): string[] {
  return ["-c", `core.hooksPath=${emptyHooksDir()}`, "-c", "core.fsmonitor=false", "-c", "protocol.ext.allow=never"];
}

/** Arguments of the push: one commit to one ref of the captured URL, never forced. */
export function pushArgs(url: string, branch: string, tip: string): string[] {
  return [
    ...hardening(),
    ...(isGithubUrl(url) ? ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"] : []),
    "push", url, `${tip}:refs/heads/${branch}`,
  ];
}

/** `owner/name` of a GitHub remote URL, or null for any other URL. */
export function githubSlug(url: string): string | null {
  if (!isGithubUrl(url)) return null;
  const m = /github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url);
  return m ? `${m[1]}/${m[2]}` : null;
}

const HEX40 = /^[0-9a-f]{40}$/;

interface FileState {
  /** null for a directory */
  content: Buffer | null;
  mode: number;
}

/** What the run records before an agent runs. */
export interface GitSnapshot {
  baseBranch: string;
  /** `origin/<base>` as it was after the host fetch. Every guard measures against this. */
  baseSha: string;
  originUrl: string;
  /** The shared git directory and the worktree's own, as they were before the agents ran. */
  commonDir: string;
  gitDir: string;
  /** Guarded files by absolute path; null when absent. */
  files: Record<string, FileState | null>;
  /** The settings in each config file that matter for tampering; null when the file did not parse. */
  entries: Record<string, string[] | null>;
  hooks: Record<string, FileState>;
}

export interface Inspection {
  commits: number;
  merges: number;
  files: string[];
}

/** A fresh clone, outside the worktree, that no agent touched. Every git command in it is hardened. */
export interface CleanClone {
  /** Checkout directory; this is the `workdir` the backlog commits in. */
  dir: string;
  /** What pushing `tip` would add on top of the captured base commit. Rejects when it cannot be told. */
  inspect(tip: string): Promise<Inspection>;
  /** Check out `sha` on the branch `afk/<id>`, discarding anything there. */
  checkout(sha: string): Promise<void>;
  /** The commit the branch is at now. */
  head(): Promise<string>;
  /** Push exactly `sha` to `refs/heads/afk/<id>` of the captured origin URL. Never forced. */
  push(sha: string): Promise<void>;
  dispose(): Promise<void>;
}

export interface GitPorts {
  /** Make sure `.sandcastle/` is in `.git/info/exclude`, so sandcastle's worktrees and logs never show as untracked. */
  ensureExcluded(repoDir: string): Promise<void>;
  /** After the host fetch and before any agent runs. */
  capture(repoDir: string, workdir: string, baseBranch: string): Promise<GitSnapshot>;
  /** Compare the user's `.git` with the snapshot; when it differs, restore it and return true. */
  restoreIfTampered(snap: GitSnapshot): Promise<boolean>;
  /** The tip of `refs/heads/<branch>` as a validated 40-character hex id, or null when the branch has no ref. */
  readTip(snap: GitSnapshot, branch: string): Promise<string | null>;
  /** The clean clone, holding the base history and, when `tip` is given, the agent's commits up to it. */
  createClean(snap: GitSnapshot, branch: string, tip: string | null): Promise<CleanClone>;
  /** Remove the branch's worktree and the local branch; with `keep`, first save commits no remote has under `refs/afk-kept/`. */
  removeLocal(repoDir: string, branch: string, keep?: boolean): Promise<void>;
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

function readDir(dir: string): Record<string, FileState> {
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

/** The value of a ref read from the ref files, without running git. Rejects on a value that is not a commit id. */
export function readRefDirect(commonDir: string, ref: string): string | null {
  let value: string | null = null;
  try {
    value = readFileSync(join(commonDir, ref), "utf8").trim();
  } catch {
    try {
      for (const line of readFileSync(join(commonDir, "packed-refs"), "utf8").split(/\r?\n/)) {
        const m = /^([^\s^#]+) (\S+)$/.exec(line);
        if (m && m[2] === ref) value = m[1];
      }
    } catch {
      return null;
    }
  }
  if (value === null) return null;
  if (!HEX40.test(value)) throw new Error(`${ref} does not hold a commit id`);
  return value;
}

const neutral = () => tmpdir();

export function createGitPorts(baseEnv: NodeJS.ProcessEnv = process.env, log: (line: string) => void = () => {}): GitPorts {
  const env = gitEnv(baseEnv);
  /** A hardened git command in `cwd`. */
  const hg = (cwd: string, args: string[], o: Partial<ExecOptions> = {}) => exec("git", [...hardening(), ...args], { cwd, env, ...o });

  /** The settings of a config file that could run something, or null when git cannot parse it. */
  async function configEntries(path: string): Promise<string[] | null> {
    if (!existsSync(path)) return [];
    try {
      const out = await hg(neutral(), ["config", "--file", path, "--list", "-z"]);
      return out.split("\0").filter((e) => e !== "" && !BENIGN.has(e.split("\n")[0].toLowerCase())).sort();
    } catch {
      return null;
    }
  }

  const perWorktree = (snap: GitSnapshot) => [join(snap.gitDir, "config.worktree"), join(snap.gitDir, "commondir"), join(snap.gitDir, "gitdir"), join(snap.gitDir, "info", "attributes")];

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

    async capture(repoDir, workdir, baseBranch) {
      const commonDir = (await hg(workdir, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
      const gitDir = (await hg(workdir, ["rev-parse", "--absolute-git-dir"])).trim();
      const baseSha = (await hg(repoDir, ["rev-parse", "--verify", `refs/remotes/origin/${baseBranch}^{commit}`])).trim();
      const originUrl = (await hg(repoDir, ["config", "--get", "remote.origin.url"])).trim();
      if (!HEX40.test(baseSha)) throw new Error(`origin/${baseBranch} is not a commit id`);
      const snap: GitSnapshot = { baseBranch, baseSha, originUrl, commonDir, gitDir, files: {}, entries: {}, hooks: readDir(join(commonDir, "hooks")) };
      const guarded = [join(commonDir, "config"), join(commonDir, "config.worktree"), join(commonDir, "info", "attributes"), ...perWorktree(snap)];
      for (const p of guarded) snap.files[p] = readState(p);
      for (const p of guarded.filter((g) => /config(\.worktree)?$/.test(g))) snap.entries[p] = await configEntries(p);
      return snap;
    },

    async restoreIfTampered(snap) {
      let tampered = false;
      // The worktree's own admin directory goes away when sandcastle closes the sandbox; that is not tampering.
      const worktreeAlive = existsSync(snap.gitDir);
      const own = new Set(perWorktree(snap));
      for (const [path, before] of Object.entries(snap.files)) {
        if (own.has(path) && !worktreeAlive) continue;
        const now = readState(path);
        let changed = !same(before, now);
        if (changed && path in snap.entries) {
          // Compare what the file means, so sandcastle's own `git config user.name` is not tampering.
          // A file git cannot parse is tampering (an agent could break the parse to hide a setting).
          const entries = await configEntries(path);
          changed = entries === null || snap.entries[path] === null || JSON.stringify(entries) !== JSON.stringify(snap.entries[path]);
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
      const now = readDir(hooksDir);
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

    async readTip(snap, branch) {
      return readRefDirect(snap.commonDir, `refs/heads/${branch}`);
    },

    async createClean(snap, branch, tip) {
      const dir = mkdtempSync(join(tmpdir(), "afk-clean-"));
      const cenv = { ...env, GIT_NO_REPLACE_OBJECTS: "1" };
      const g = (args: string[], o: Partial<ExecOptions> = {}) => exec("git", [...hardening(), ...args], { cwd: dir, env: cenv, ...o });
      const remoteArgs = isGithubUrl(snap.originUrl) ? ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"] : [];
      // The no-prompt environment of remoteGitOptions; the 15 s limit it uses for `ls-remote` is too short for a clone.
      const remote = (args: string[]) => exec("git", [...hardening(), ...remoteArgs, ...args], { cwd: dir, env: cenv, timeoutMs: 300_000 });
      const dispose = async () => {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      };
      try {
        await g(["init", "-q"]);
        // The base history, from the captured URL, never from the shared repository.
        await remote(["fetch", "--quiet", "--no-tags", snap.originUrl, `+refs/heads/${snap.baseBranch}:refs/afk/base`]);
        const haveBase = () => g(["cat-file", "-e", `${snap.baseSha}^{commit}`]).then(() => true, () => false);
        if (!(await haveBase())) await remote(["fetch", "--quiet", "--no-tags", snap.originUrl, snap.baseSha]).catch(() => {});
        if (!(await haveBase())) throw new Error(`the base commit ${snap.baseSha} is not on origin any more`);

        if (tip !== null) {
          if (!HEX40.test(tip)) throw new Error("the tip is not a commit id");
          // Copy the agent's objects. The shared object directory is attached as an alternate, which makes git
          // read object files from it and nothing else, then `index-pack --strict` re-hashes and fsck-checks
          // every object into the clean clone's own store. (A fetch from the shared repository would start
          // `git upload-pack` in it, which reads that repository's config.)
          const alt = join(dir, ".git", "objects", "info", "alternates");
          mkdirSync(dirname(alt), { recursive: true });
          writeFileSync(alt, `${join(snap.commonDir, "objects").replaceAll("\\", "/")}\n`);
          const pack = await execRaw("git", [...hardening(), "pack-objects", "--revs", "--stdout", "-q"], { cwd: dir, env: cenv, input: `${tip}\n^${snap.baseSha}\n` });
          rmSync(alt, { force: true });
          await execRaw("git", [...hardening(), "index-pack", "--stdin", "--strict"], { cwd: dir, env: cenv, input: pack });
          const type = (await g(["cat-file", "-t", tip])).trim();
          if (type !== "commit") throw new Error(`the tip ${tip} is a ${type}, not a commit`);
          await g(["rev-list", "--objects", "--quiet", tip, "--not", snap.baseSha]); // every object it needs arrived
          await g(["update-ref", "refs/afk/tip", tip]);
        }
      } catch (e) {
        await dispose();
        throw e;
      }

      return {
        dir,
        async inspect(sha) {
          const mergeBase = (await g(["merge-base", snap.baseSha, sha])).trim();
          const range = `${snap.baseSha}..${sha}`;
          const commits = Number((await g(["rev-list", "--count", range])).trim());
          const merges = Number((await g(["rev-list", "--merges", "--count", range])).trim());
          // The net tree change catches what a merge commit adds; the per-commit paths catch a file added and
          // removed again. Both are pushed, so both are checked.
          const tree = await g(["diff", "--name-only", "--no-renames", "-z", mergeBase, sha]);
          const perCommit = await g(["log", "--no-merges", "--no-renames", "--name-only", "--format=", "-z", range]);
          return { commits, merges, files: [...new Set([...tree.split("\0"), ...perCommit.split("\0")].filter((f) => f !== ""))] };
        },
        async checkout(sha) {
          await g(["checkout", "--force", "-q", "-B", branch, sha]);
        },
        async head() {
          return (await g(["rev-parse", "--verify", `refs/heads/${branch}`])).trim();
        },
        async push(sha) {
          if (!HEX40.test(sha)) throw new Error("refusing to push something that is not a commit id");
          await exec("git", pushArgs(snap.originUrl, branch, sha), { cwd: dir, env: cenv, timeoutMs: 300_000 });
        },
        dispose,
      };
    },

    async removeLocal(repoDir, branch, keep = false) {
      await removeStale(repoDir, branch, { env, keep, log });
    },
  };
}

/**
 * Remove the worktree that has `branch` checked out, if any, then the local branch. Idempotent.
 * With `keep`, commits on the branch that no remote-tracking ref has are first saved under
 * `refs/afk-kept/<id>/<timestamp>` (and logged), so clearing a stale branch never destroys work.
 */
export async function removeStale(
  repoDir: string,
  branch: string,
  o: { env?: NodeJS.ProcessEnv; keep?: boolean; log?: (line: string) => void; now?: () => Date } = {},
): Promise<void> {
  const env = o.env ?? gitEnv();
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
  const sha = await hg(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).then((s) => s.trim(), () => null);
  if (sha === null) return;
  if (o.keep) {
    const unsaved = Number((await hg(["rev-list", "--count", ref, "--not", "--remotes"])).trim());
    if (unsaved > 0) {
      const stamp = (o.now?.() ?? new Date()).toISOString().replace(/[-:.]/g, "");
      const kept = `refs/afk-kept/${branch.replace(/^afk\//, "")}/${stamp}`;
      await hg(["update-ref", kept, sha]);
      o.log?.(`afk: ${ref} had ${unsaved} commit(s) no remote has; saved them as ${kept} before clearing the branch`);
    }
  }
  await hg(["branch", "-D", branch]);
}

/** Whether `refs/heads/<branch>` exists on origin, which is what a claim is. Rejects when origin is unreachable. */
export async function remoteHasBranch(repoDir: string, branch: string, env: NodeJS.ProcessEnv = gitEnv()): Promise<boolean> {
  const out = await exec("git", [...hardening(), "ls-remote", "--heads", "origin", `refs/heads/${branch}`], { cwd: repoDir, env, timeoutMs: 60_000 });
  return out.trim() !== "";
}
