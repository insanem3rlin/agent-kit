// Small git queries shared by `afk init` and the engine.
import { execFileSync } from "node:child_process";

/** stdout of `git <args>` run in `cwd`, or null when git fails (or is missing). */
function git(cwd: string, ...args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/**
 * Like git(), for a command that talks to the remote: it never prompts (no
 * terminal prompt, no SSH host-key or passphrase question, no credential
 * manager window) and gives up after a timeout, so `afk init` cannot hang.
 */
function gitRemote(cwd: string, ...args: string[]): string | null {
  // BatchMode only where the user has not chosen an ssh command of their own
  // (GIT_SSH_COMMAND overrides GIT_SSH and core.sshCommand, so setting it blindly
  // would swap out their ssh and key).
  const ownSsh = process.env.GIT_SSH_COMMAND || process.env.GIT_SSH || git(cwd, "config", "core.sshCommand");
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15_000,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "never",
        ...(ownSsh ? {} : { GIT_SSH_COMMAND: "ssh -o BatchMode=yes" }),
      },
    }).trim();
  } catch {
    return null;
  }
}

/** The root of the work tree containing `dir`, or null outside a git work tree. */
export function repoRoot(dir: string): string | null {
  return git(dir, "rev-parse", "--show-toplevel") || null;
}

/**
 * Whether a remote URL points at github.com (https, http, git, ssh:// and
 * scp-style forms, with or without a user). An SSH host alias from
 * ~/.ssh/config (such as `git@github-work:o/r.git`) is not resolved and reads
 * as not GitHub.
 */
export function isGithubUrl(url: string): boolean {
  const scp = /^(?:[^@\s/:]+@)?([^:/\s]+):(?!\/\/)/.exec(url);
  if (scp) return scp[1].toLowerCase() === "github.com";
  try {
    return new URL(url).hostname.toLowerCase() === "github.com";
  } catch {
    return false;
  }
}

/** Whether the `origin` remote of the repository at `dir` is on GitHub. */
export function originOnGithub(dir: string): boolean {
  const url = git(dir, "remote", "get-url", "origin");
  return url !== null && isGithubUrl(url);
}

/**
 * The repository's default branch. Asked of the remote when one exists
 * (`origin/HEAD` locally, else `ls-remote --symref`); without one, `main` or
 * `master` if that branch exists, else "main". The current branch is never
 * used: run from a feature branch it would make every AFK run target it.
 */
export function detectBaseBranch(dir: string): string {
  const hasOrigin = git(dir, "remote", "get-url", "origin") !== null;
  if (hasOrigin) {
    const local = git(dir, "symbolic-ref", "--short", "refs/remotes/origin/HEAD");
    if (local) return local.replace(/^origin\//, "");
    const remote = gitRemote(dir, "ls-remote", "--symref", "origin", "HEAD");
    const m = remote && /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(remote);
    if (m) return m[1];
  }
  for (const name of ["main", "master"]) {
    if (git(dir, "show-ref", "--verify", "--quiet", `refs/heads/${name}`) !== null) return name;
    if (hasOrigin && git(dir, "show-ref", "--verify", "--quiet", `refs/remotes/origin/${name}`) !== null) return name;
  }
  return "main";
}
