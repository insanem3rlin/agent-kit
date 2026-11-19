import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { detectBaseBranch, isGithubUrl, originOnGithub, repoRoot } from "../src/git.ts";

const identity = ["-c", "user.name=t", "-c", "user.email=t@example.invalid"];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", [...identity, ...args], { cwd, encoding: "utf8" }).trim();
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "afk-git-"));
}

function repo(branch: string): string {
  const dir = tmp();
  git(dir, "init", "-q", "-b", branch);
  git(dir, "commit", "-q", "--allow-empty", "-m", "first");
  return dir;
}

test("isGithubUrl accepts the https, ssh and scp forms of github.com", () => {
  for (const url of [
    "https://github.com/o/r.git",
    "https://user@github.com/o/r", // leak-check: allow
    "http://github.com/o/r",
    "git@github.com:o/r.git", // leak-check: allow
    "ssh://git@github.com/o/r.git", // leak-check: allow
    "git://github.com/o/r.git",
  ]) {
    assert.equal(isGithubUrl(url), true, url);
  }
});

test("isGithubUrl rejects other hosts, lookalikes and local paths", () => {
  for (const url of [
    "https://gitlab.com/o/r.git",
    "git@gitlab.com:o/r.git", // leak-check: allow
    "https://github.com.evil.example/o/r",
    "https://example.com/github.com/o/r",
    "git@notgithub.com:o/r.git", // leak-check: allow
    "/srv/git/r.git",
    "",
  ]) {
    assert.equal(isGithubUrl(url), false, url);
  }
});

test("originOnGithub reads the origin remote, and is false without one", () => {
  const dir = repo("main");
  assert.equal(originOnGithub(dir), false);
  git(dir, "remote", "add", "origin", "git@github.com:o/r.git"); // leak-check: allow
  assert.equal(originOnGithub(dir), true);
  git(dir, "remote", "set-url", "origin", "https://gitlab.com/o/r.git");
  assert.equal(originOnGithub(dir), false);
});

test("repoRoot finds the work tree root from a subdirectory, and is null outside one", () => {
  const dir = repo("main");
  const sub = join(dir, "a", "b");
  mkdirSync(sub, { recursive: true });
  assert.equal(realpathSync.native(repoRoot(sub)!), realpathSync.native(dir));
  assert.equal(repoRoot(tmp()), null);
});

test("detectBaseBranch asks the remote for its HEAD, ignoring the current branch", () => {
  const bare = tmp();
  git(bare, "init", "-q", "--bare", "-b", "trunk");
  const dir = repo("trunk");
  git(dir, "remote", "add", "origin", bare);
  git(dir, "push", "-q", "origin", "trunk");
  git(dir, "checkout", "-q", "-b", "feature/x");
  assert.equal(detectBaseBranch(dir), "trunk");
});

test("without a remote, detectBaseBranch prefers main, then master, never the current branch", () => {
  const onMaster = repo("master");
  git(onMaster, "checkout", "-q", "-b", "feature/x");
  assert.equal(detectBaseBranch(onMaster), "master");

  const both = repo("main");
  git(both, "branch", "master");
  git(both, "checkout", "-q", "-b", "feature/x");
  assert.equal(detectBaseBranch(both), "main");

  const neither = repo("feature/x");
  assert.equal(detectBaseBranch(neither), "main");
});
