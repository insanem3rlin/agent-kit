import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createGitPorts, pushArgs, remoteHasBranch, removeStale } from "../src/hostgit.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const fwd = (p: string) => p.replaceAll("\\", "/");

interface Fixture {
  root: string;
  origin: string;
  work: string;
  wt: string;
  marker: string;
}

/** A bare origin, a clone with one commit on main, and a linked worktree on afk/7 (what sandcastle makes). */
function fixture(): Fixture {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "afk-hostgit-")));
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  const wt = join(root, "wt");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, work);
  writeFileSync(join(work, "README.md"), "hi\n");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "init");
  git(work, "branch", "-M", "main");
  git(work, "push", "-q", "origin", "main");
  git(work, "worktree", "add", "-q", "-b", "afk/7", wt, "origin/main");
  return { root, origin, work, wt, marker: join(root, "MARKER") };
}

const commit = (f: Fixture, file: string, content = "x\n") => {
  mkdirSync(join(f.wt, file, ".."), { recursive: true });
  writeFileSync(join(f.wt, file), content);
  git(f.wt, "add", "-A");
  git(f.wt, "commit", "-q", "-m", `add ${file}`);
};

const evilScript = (f: Fixture) => `#!/bin/sh\necho ran > "${fwd(f.marker)}"\n`;

test("a planted hook is detected, removed, and would not have run anyway", async () => {
  const f = fixture();
  const ports = createGitPorts();
  const snap = await ports.snapshot(f.wt);
  commit(f, "a.txt");
  const hook = join(f.work, ".git", "hooks", "pre-push");
  writeFileSync(hook, evilScript(f), { mode: 0o755 });
  // Not restored: the hardened push must not run it.
  const r = await ports.resolve(f.wt, "afk/7", "origin/main");
  assert.ok("tip" in r);
  await ports.push(f.wt, snap, "afk/7", r.tip);
  assert.equal(existsSync(f.marker), false, "the planted pre-push hook ran on the host");
  assert.equal(await ports.restoreIfTampered(f.wt, snap), true);
  assert.equal(existsSync(hook), false);
  assert.equal(await ports.restoreIfTampered(f.wt, snap), false);
});

test("planted post-checkout and reference-transaction hooks and hooksPath do not run during reset", async () => {
  const f = fixture();
  const ports = createGitPorts();
  const snap = await ports.snapshot(f.wt);
  commit(f, "a.txt");
  for (const name of ["post-checkout", "reference-transaction", "post-commit"]) {
    writeFileSync(join(f.work, ".git", "hooks", name), evilScript(f), { mode: 0o755 });
  }
  const evilDir = join(f.root, "evilhooks");
  mkdirSync(evilDir);
  writeFileSync(join(evilDir, "post-checkout"), evilScript(f), { mode: 0o755 });
  git(f.work, "config", "core.hooksPath", evilDir);
  git(f.work, "config", "core.fsmonitor", `sh -c 'echo ran > ${fwd(f.marker)}'`);
  await ports.resetBranch(f.wt, "afk/7", "origin/main");
  await ports.resolve(f.wt, "afk/7", "origin/main");
  assert.equal(existsSync(f.marker), false, "planted code ran on the host");
  assert.equal(await ports.restoreIfTampered(f.wt, snap), true);
  assert.ok(!git(f.work, "config", "--local", "--list").includes("core.hookspath"));
  assert.ok(!git(f.work, "config", "--local", "--list").includes("core.fsmonitor"));
});

test("config tampering (sshCommand, credential.helper, insteadOf, include.path) is detected and restored", async () => {
  const f = fixture();
  const ports = createGitPorts();
  const before = readFileSync(join(f.work, ".git", "config"), "utf8");
  const snap = await ports.snapshot(f.wt);
  git(f.work, "config", "core.sshCommand", "evil");
  git(f.work, "config", "credential.helper", "!evil");
  git(f.work, "config", "url.https://evil.test/.insteadOf", "https://github.com/");
  git(f.work, "config", "include.path", "/tmp/evil");
  assert.equal(await ports.restoreIfTampered(f.wt, snap), true);
  assert.equal(readFileSync(join(f.work, ".git", "config"), "utf8"), before);
});

test("config.worktree tampering is detected", async () => {
  const f = fixture();
  const ports = createGitPorts();
  const snap = await ports.snapshot(f.wt);
  const gitDir = git(f.wt, "rev-parse", "--absolute-git-dir");
  writeFileSync(join(gitDir, "config.worktree"), "[core]\n\tfsmonitor = evil\n");
  assert.equal(await ports.restoreIfTampered(f.wt, snap), true);
  assert.equal(existsSync(join(gitDir, "config.worktree")), false);
});

test("sandcastle's own git setup (user, safe.directory) is not tampering", async () => {
  const f = fixture();
  const ports = createGitPorts();
  const snap = await ports.snapshot(f.wt);
  git(f.work, "config", "user.name", "Agent");
  git(f.work, "config", "--add", "safe.directory", "/home/agent/workspace");
  assert.equal(await ports.restoreIfTampered(f.wt, snap), false);
});

test("the push goes to the origin URL captured before the run, not the one in the config now", async () => {
  const f = fixture();
  const ports = createGitPorts();
  const snap = await ports.snapshot(f.wt);
  commit(f, "a.txt");
  git(f.work, "remote", "set-url", "origin", join(f.root, "evil.git"));
  const r = await ports.resolve(f.wt, "afk/7", "origin/main");
  assert.ok("tip" in r);
  await ports.push(f.wt, snap, "afk/7", r.tip);
  assert.equal(git(f.origin, "rev-parse", "refs/heads/afk/7"), r.tip);
  assert.equal(existsSync(join(f.root, "evil.git")), false);
});

test("an evil merge that adds a workflow is visible to inspect, and counted as a merge", async () => {
  const f = fixture();
  const ports = createGitPorts();
  git(f.wt, "checkout", "-q", "-b", "side", "origin/main");
  commit(f, "s.txt");
  git(f.wt, "checkout", "-q", "afk/7");
  commit(f, "a.txt");
  git(f.wt, "merge", "-q", "--no-commit", "--no-ff", "side");
  mkdirSync(join(f.wt, ".github", "workflows"), { recursive: true });
  writeFileSync(join(f.wt, ".github", "workflows", "x.yml"), "on: push\n");
  git(f.wt, "add", "-A");
  git(f.wt, "commit", "-q", "-m", "merge side");
  // the old guard: `git log --name-only` lists nothing for the merge commit itself
  assert.ok(!git(f.wt, "log", "--name-only", "--format=", "-1").includes("x.yml"));
  const r = await ports.resolve(f.wt, "afk/7", "origin/main");
  assert.ok("tip" in r);
  const info = await ports.inspect(f.wt, r.base, r.tip);
  assert.ok(info.files.includes(".github/workflows/x.yml"), `files: ${info.files}`);
  assert.equal(info.merges, 1);
});

test("inspect counts commits and lists every touched path, including deletions and renames", async () => {
  const f = fixture();
  const ports = createGitPorts();
  commit(f, "a.txt");
  git(f.wt, "mv", "a.txt", "b.txt");
  git(f.wt, "commit", "-q", "-m", "rename");
  git(f.wt, "rm", "-q", "README.md");
  git(f.wt, "commit", "-q", "-m", "rm");
  const r = await ports.resolve(f.wt, "afk/7", "origin/main");
  assert.ok("tip" in r);
  const info = await ports.inspect(f.wt, r.base, r.tip);
  assert.equal(info.commits, 3);
  assert.equal(info.merges, 0);
  assert.deepEqual([...info.files].sort(), ["README.md", "a.txt", "b.txt"]); // a.txt: added then renamed away, still in the pushed history
});

test("resolve refuses a detached HEAD and a HEAD on another branch", async () => {
  const f = fixture();
  const ports = createGitPorts();
  assert.ok("tip" in (await ports.resolve(f.wt, "afk/7", "origin/main")));
  git(f.wt, "checkout", "-q", "--detach");
  assert.ok("error" in (await ports.resolve(f.wt, "afk/7", "origin/main")));
  git(f.wt, "checkout", "-q", "-b", "other");
  assert.ok("error" in (await ports.resolve(f.wt, "afk/7", "origin/main")));
});

test("what is pushed is exactly the guarded sha, not a later HEAD", async () => {
  const f = fixture();
  const ports = createGitPorts();
  const snap = await ports.snapshot(f.wt);
  commit(f, "a.txt");
  const r = await ports.resolve(f.wt, "afk/7", "origin/main");
  assert.ok("tip" in r);
  commit(f, ".github/workflows/late.yml", "on: push\n");
  await ports.push(f.wt, snap, "afk/7", r.tip);
  assert.equal(git(f.origin, "rev-parse", "refs/heads/afk/7"), r.tip);
});

test("resetBranch moves the named branch back to the base, even from a detached HEAD", async () => {
  const f = fixture();
  const ports = createGitPorts();
  commit(f, "a.txt");
  git(f.wt, "checkout", "-q", "--detach");
  await ports.resetBranch(f.wt, "afk/7", "origin/main");
  assert.equal(git(f.wt, "rev-parse", "refs/heads/afk/7"), git(f.wt, "rev-parse", "origin/main"));
  assert.equal(git(f.wt, "symbolic-ref", "HEAD"), "refs/heads/afk/7");
});

test("pushArgs use the gh credential helper only for a GitHub remote", () => {
  const gh = pushArgs("https://github.com/o/r.git", "afk/7", "abc").join(" ");
  assert.match(gh, /gh auth git-credential/);
  const other = pushArgs("https://git.example.test/o/r.git", "afk/7", "abc").join(" ");
  assert.doesNotMatch(other, /credential/);
  for (const a of [gh, other]) {
    assert.match(a, /abc:refs\/heads\/afk\/7/);
    assert.match(a, /core\.hooksPath=/);
    assert.match(a, /core\.fsmonitor=false/);
    assert.doesNotMatch(a, /--force|--set-upstream| \+/);
  }
});

test("removeStale deletes a leftover worktree and branch; remoteHasBranch sees claims", async () => {
  const f = fixture();
  assert.equal(await remoteHasBranch(f.work, "afk/7"), false);
  await removeStale(f.work, "afk/7");
  assert.equal(existsSync(f.wt), false);
  assert.throws(() => git(f.work, "rev-parse", "--verify", "refs/heads/afk/7"));
  await removeStale(f.work, "afk/7"); // idempotent
  git(f.work, "push", "-q", "origin", "main:refs/heads/afk/8");
  assert.equal(await remoteHasBranch(f.work, "afk/8"), true);
});

test("removeLocal drops the worktree and the branch", async () => {
  const f = fixture();
  await createGitPorts().removeLocal(f.work, "afk/7");
  assert.equal(existsSync(f.wt), false);
  assert.throws(() => git(f.work, "rev-parse", "--verify", "refs/heads/afk/7"));
});

test("ensureExcluded lists .sandcastle/ once, in .git/info/exclude", async () => {
  const f = fixture();
  const ports = createGitPorts();
  await ports.ensureExcluded(f.work);
  await ports.ensureExcluded(f.work);
  const lines = readFileSync(join(f.work, ".git", "info", "exclude"), "utf8").split("\n").filter((l) => l === ".sandcastle/");
  assert.equal(lines.length, 1);
  mkdirSync(join(f.work, ".sandcastle"));
  writeFileSync(join(f.work, ".sandcastle", "log"), "x");
  assert.equal(git(f.work, "status", "--porcelain"), "");
});
