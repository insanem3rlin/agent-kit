import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
export const fwd = (p: string) => p.replaceAll("\\", "/");

export interface Fixture {
  root: string;
  origin: string;
  /** the user's own repository */
  user: string;
  marker: string;
  baseSha: string;
}

/** A bare origin and the user's clone of it with one commit on main. */
export function fixture(): Fixture {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "afk-hostgit-")));
  const origin = join(root, "origin.git");
  const user = join(root, "user");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, user);
  writeFileSync(join(user, "README.md"), "hi\n");
  git(user, "add", ".");
  git(user, "commit", "-q", "-m", "init");
  git(user, "branch", "-M", "main");
  git(user, "push", "-q", "origin", "main");
  return { root, origin, user, marker: join(root, "MARKER"), baseSha: git(user, "rev-parse", "HEAD") };
}

/** A hash of every file and directory name under `dir`, so "byte-identical" is checkable. */
export function treeHash(dir: string): string {
  const h = createHash("sha256");
  const walk = (d: string, rel: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = lstatSync(p);
      h.update(`${rel}/${name}:${st.isDirectory() ? "d" : st.isSymbolicLink() ? "l" : "f"}\n`);
      if (st.isDirectory()) walk(p, `${rel}/${name}`);
      else if (st.isFile()) h.update(readFileSync(p));
    }
  };
  walk(dir, "");
  return h.digest("hex");
}

