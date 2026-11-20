// Everything the run does with git on the host around an agent that had write access to a
// repository.
//
// The boundary. sandcastle bind-mounts a repository's `.git` writable into the container,
// so after an agent ran nothing in that repository can be trusted: not its config, hooks,
// refs, replace refs, packed-refs, object store, `objects/info/alternates`, nor the
// `commondir` / `gitdir` files that tell git which repository a worktree belongs to. So:
//   1. The user's own repository is never mounted, written or fetched. The run reads the URL
//      of `origin` from it once (originUrl), before any agent runs.
//   2. createRunClone() makes a disposable clone of that URL in the temp directory (`--no-local`,
//      so it shares no objects or hardlinks with anything) and checks out `origin/<base>`. That
//      clone is what sandcastle gets as its `cwd`: its `.git` and `.sandcastle/` worktree are what
//      the container mounts. It is created with git's default files ref backend; if a global
//      `init.defaultRefFormat` made it reftable, readTip() asks a hardened git instead of reading
//      the ref files. The run clone is never trusted after the agents start.
//   3. After the agents (container stopped), readTip() reads the one value the run needs from
//      the run clone, the tip of `refs/heads/afk/<id>`, and validates it as 40 hex characters.
//   4. createClean() makes a second, fresh clone that no agent touched. It fetches the base
//      history from the captured URL and imports the agent's objects from the run clone:
//      object files are copied (never `objects/info/`, never a symlink) into a directory that
//      becomes the only alternate, then `pack-objects` + `index-pack --strict` re-hash and
//      fsck them into the clean clone's own store. Anything that cannot be imported is an
//      ImportError (the issue is blocked), not an environment failure.
//   5. Every guard, the label-swap commit of the Backlog.md backlog and the push happen in the
//      clean clone, against the captured base commit and the validated tip, with replace refs
//      off, hooks off and fsmonitor off.
import { execFile } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const githubHelper = (url: string) => (isGithubUrl(url) ? ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"] : []);

/** Arguments of the push: one commit to one ref of the captured URL, never forced. */
export function pushArgs(url: string, branch: string, tip: string): string[] {
  return [...hardening(), ...githubHelper(url), "push", url, `${tip}:refs/heads/${branch}`];
}

/** `owner/name` of a GitHub remote URL, or null for any other URL. */
export function githubSlug(url: string): string | null {
  if (!isGithubUrl(url)) return null;
  const m = /github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url);
  return m ? `${m[1]}/${m[2]}` : null;
}

const HEX40 = /^[0-9a-f]{40}$/;

/** The agent's commits cannot be brought into the clean clone. The issue is blocked; the environment is fine. */
export class ImportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ImportError";
  }
}

export interface Inspection {
  commits: number;
  merges: number;
  files: string[];
}

/** The disposable clone an agent works in. Untrusted from the moment the agents start. */
export interface RunClone {
  /** Checkout directory; sandcastle's `cwd`. */
  dir: string;
  baseBranch: string;
  /** `origin/<base>` as cloned. Every guard measures against this, never against a ref in a clone. */
  baseSha: string;
  originUrl: string;
  commonDir: string;
  gitDir: string;
  /** The tip of `refs/heads/<branch>` as a validated 40-character hex id, or null when the branch has no ref. */
  readTip(branch: string): Promise<string | null>;
  /** Delete the clone. */
  dispose(): Promise<void>;
}

/** A fresh clone, outside the run clone, that no agent touched. Every git command in it is hardened. */
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
  /** `remote.origin.url` of the user's repository, read once, before anything else, without writing to it. */
  originUrl(repoDir: string): Promise<string>;
  /** Clone `url` into the temp directory and check out `origin/<baseBranch>`. */
  createRunClone(url: string, baseBranch: string, id: string): Promise<RunClone>;
  /** The clean clone, holding the base history and, when `tip` is given, the agent's commits up to it. Rejects with ImportError when they cannot be imported. */
  createClean(run: RunClone, branch: string, tip: string | null): Promise<CleanClone>;
}

/** The value of a ref read from the ref files, without running git. Rejects on a value that is not a commit id. */
export function readRefDirect(commonDir: string, ref: string): string | null {
  let value: string | null = null;
  const loose = join(commonDir, ref);
  if (existsSync(loose)) {
    if (!lstatSync(loose).isFile()) throw new Error(`${ref} is not a plain file`);
    value = readFileSync(loose, "utf8").trim();
  } else {
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

/** Delete a directory tree, also when an agent made parts of it read-only. */
function forceRemove(dir: string): void {
  const rm = () => rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  try {
    rm();
  } catch (e) {
    const open = (d: string) => {
      try {
        chmodSync(d, 0o777);
        for (const entry of readdirSync(d, { withFileTypes: true })) {
          const p = join(d, entry.name);
          if (entry.isDirectory()) open(p);
          else chmodSync(p, 0o666);
        }
      } catch {
        /* best effort */
      }
    };
    open(dir);
    try {
      rm();
    } catch {
      throw e;
    }
  }
}

/**
 * Copy the object files of `src` into `dst`: the `pack` directory and the two-hex-digit loose
 * directories, nothing else (not `info/`, which holds `alternates`). A symlink or any other kind of
 * entry, and more than `max` bytes, is refused.
 */
function copyObjects(src: string, dst: string, max: number): void {
  if (!existsSync(src)) throw new ImportError("the run clone has no object directory");
  let total = 0;
  const copyFiles = (from: string, to: string) => {
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from)) {
      const st = lstatSync(join(from, name));
      if (!st.isFile()) throw new ImportError(`${join(from, name)} is not a plain file`);
      total += st.size;
      if (total > max) throw new ImportError(`the agent's objects are larger than ${max} bytes`);
      copyFileSync(join(from, name), join(to, name));
    }
  };
  for (const name of readdirSync(src)) {
    if (name !== "pack" && !/^[0-9a-f]{2}$/.test(name)) continue;
    const st = lstatSync(join(src, name));
    if (!st.isDirectory()) throw new ImportError(`${join(src, name)} is not a directory`);
    copyFiles(join(src, name), join(dst, name));
  }
}

export function createGitPorts(
  baseEnv: NodeJS.ProcessEnv = process.env,
  log: (line: string) => void = () => {},
  opts: { maxImportBytes?: number } = {},
): GitPorts {
  const env = gitEnv(baseEnv);
  const maxImport = opts.maxImportBytes ?? 1024 ** 3;
  const neutral = () => tmpdir();
  // The no-prompt environment of remoteGitOptions; its 15 s limit is too short for a clone.
  const remote = (url: string, cwd: string, args: string[], cenv: NodeJS.ProcessEnv = env) =>
    exec("git", [...hardening(), ...githubHelper(url), ...args], { cwd, env: cenv, timeoutMs: 300_000 });

  return {
    async originUrl(repoDir) {
      const url = (await exec("git", [...hardening(), "config", "--get", "remote.origin.url"], { cwd: repoDir, env })).trim();
      if (url === "") throw new Error(`${repoDir} has no remote.origin.url`);
      return url;
    },

    async createRunClone(url, baseBranch, id) {
      const dir = mkdtempSync(join(tmpdir(), `afk-run-${id}-`));
      const commonDir = join(dir, ".git");
      const g = (args: string[]) => exec("git", [...hardening(), ...args], { cwd: dir, env: { ...env, GIT_NO_REPLACE_OBJECTS: "1" } });
      try {
        await remote(url, neutral(), ["clone", "--quiet", "--no-local", "--no-checkout", "--", url, dir]);
        await g(["checkout", "--quiet", "--detach", `refs/remotes/origin/${baseBranch}`]);
        const baseSha = (await g(["rev-parse", "--verify", `refs/remotes/origin/${baseBranch}^{commit}`])).trim();
        if (!HEX40.test(baseSha)) throw new Error(`origin/${baseBranch} is not a commit id`);
        return {
          dir,
          baseBranch,
          baseSha,
          originUrl: url,
          commonDir,
          gitDir: commonDir,
          async readTip(branch) {
            const ref = `refs/heads/${branch}`;
            let config = "";
            try {
              config = readFileSync(join(commonDir, "config"), "utf8");
            } catch {
              /* a missing config is read as the files backend */
            }
            if (!/refstorage\s*=\s*reftable/i.test(config)) return readRefDirect(commonDir, ref);
            const out = await exec("git", [...hardening(), `--git-dir=${commonDir}`, "rev-parse", "--verify", "--quiet", ref], {
              cwd: neutral(),
              env: { ...env, GIT_NO_REPLACE_OBJECTS: "1" },
            }).then((s) => s.trim(), () => null);
            if (out === null) return null;
            if (!HEX40.test(out)) throw new Error(`${ref} does not hold a commit id`);
            return out;
          },
          async dispose() {
            forceRemove(dir);
          },
        };
      } catch (e) {
        try {
          forceRemove(dir);
        } catch {
          log(`afk: could not delete ${dir}`);
        }
        throw e;
      }
    },

    async createClean(run, branch, tip) {
      const dir = mkdtempSync(join(tmpdir(), "afk-clean-"));
      const cenv = { ...env, GIT_NO_REPLACE_OBJECTS: "1" };
      const g = (args: string[], o: Partial<ExecOptions> = {}) => exec("git", [...hardening(), ...args], { cwd: dir, env: cenv, ...o });
      const dispose = async () => {
        forceRemove(dir);
      };
      try {
        await g(["init", "-q"]);
        // The base history, from the captured URL, never from a repository an agent could write.
        await remote(run.originUrl, dir, ["fetch", "--quiet", "--no-tags", run.originUrl, `+refs/heads/${run.baseBranch}:refs/afk/base`], cenv);
        const haveBase = () => g(["cat-file", "-e", `${run.baseSha}^{commit}`]).then(() => true, () => false);
        if (!(await haveBase())) await remote(run.originUrl, dir, ["fetch", "--quiet", "--no-tags", run.originUrl, run.baseSha], cenv).catch(() => {});
        if (!(await haveBase())) throw new Error(`the base commit ${run.baseSha} is not on origin any more`);

        if (tip !== null) {
          try {
            if (!HEX40.test(tip)) throw new ImportError("the tip is not a commit id");
            // Copy the agent's object files (never info/, never a symlink) and make that copy the only
            // alternate, so nothing an `alternates` file in the run clone points at is ever read; then
            // `index-pack --strict` re-hashes and fsck-checks every object into the clean clone's own store.
            const copy = join(dir, ".git", "afk-import");
            copyObjects(join(run.commonDir, "objects"), copy, maxImport);
            const alt = join(dir, ".git", "objects", "info", "alternates");
            mkdirSync(join(dir, ".git", "objects", "info"), { recursive: true });
            writeFileSync(alt, `${copy.replaceAll("\\", "/")}\n`);
            const pack = await execRaw("git", [...hardening(), "pack-objects", "--revs", "--stdout", "-q"], { cwd: dir, env: cenv, input: `${tip}\n^${run.baseSha}\n` });
            rmSync(alt, { force: true });
            await execRaw("git", [...hardening(), "index-pack", "--stdin", "--strict"], { cwd: dir, env: cenv, input: pack });
            forceRemove(copy);
            const type = (await g(["cat-file", "-t", tip])).trim();
            if (type !== "commit") throw new ImportError(`the tip ${tip} is a ${type}, not a commit`);
            await g(["rev-list", "--objects", "--quiet", tip, "--not", run.baseSha]); // every object it needs arrived
            await g(["update-ref", "refs/afk/tip", tip]);
          } catch (e) {
            throw e instanceof ImportError ? e : new ImportError(`importing ${tip}: ${(e as Error).message}`, { cause: e });
          }
        }
      } catch (e) {
        try {
          await dispose();
        } catch {
          log(`afk: could not delete ${dir}`);
        }
        throw e;
      }

      return {
        dir,
        async inspect(sha) {
          const mergeBase = (await g(["merge-base", run.baseSha, sha])).trim();
          const range = `${run.baseSha}..${sha}`;
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
          await exec("git", pushArgs(run.originUrl, branch, sha), { cwd: dir, env: cenv, timeoutMs: 300_000 });
        },
        dispose,
      };
    },
  };
}

/** Whether `refs/heads/<branch>` exists on origin, which is what a claim is. Rejects when origin is unreachable. */
export async function remoteHasBranch(repoDir: string, branch: string, env: NodeJS.ProcessEnv = gitEnv()): Promise<boolean> {
  const out = await exec("git", [...hardening(), "ls-remote", "--heads", "origin", `refs/heads/${branch}`], { cwd: repoDir, env, timeoutMs: 60_000 });
  return out.trim() !== "";
}
