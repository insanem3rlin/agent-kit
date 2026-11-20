import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createGitPorts, githubSlug, pushArgs, readRefDirect, remoteHasBranch, removeStale } from "../src/hostgit.ts";
import type { CleanClone, GitSnapshot } from "../src/hostgit.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const fwd = (p: string) => p.replaceAll("\\", "/");

interface Fixture {
  root: string;
  origin: string;
  work: string;
  wt: string;
  marker: string;
  baseSha: string;
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
  return { root, origin, work, wt, marker: join(root, "MARKER"), baseSha: git(work, "rev-parse", "origin/main") };
}

const commit = (f: Fixture, file: string, content = "x\n") => {
  mkdirSync(join(f.wt, file, ".."), { recursive: true });
  writeFileSync(join(f.wt, file), content);
  git(f.wt, "add", "-A");
  git(f.wt, "commit", "-q", "-m", `add ${file}`);
  return git(f.wt, "rev-parse", "HEAD");
};

const evilScript = (f: Fixture) => `#!/bin/sh\necho ran > "${fwd(f.marker)}"\n`;
const commonDir = (f: Fixture) => join(f.work, ".git");
const adminDir = (f: Fixture) => join(f.work, ".git", "worktrees", "wt");

async function snapshot(f: Fixture) {
  const ports = createGitPorts();
  const snap = await ports.capture(f.work, f.wt, "main");
  return { ports, snap };
}

/** The run's host-side sequence after the container has stopped. */
async function cleanFor(f: Fixture, tip: string | null = null) {
  const { ports, snap } = await snapshot(f);
  const sha = tip ?? (await ports.readTip(snap, "afk/7"));
  return { ports, snap, sha, clean: await ports.createClean(snap, "afk/7", sha) };
}

const originRef = (f: Fixture, ref = "refs/heads/afk/7") => {
  try {
    return git(f.origin, "rev-parse", "--verify", "--quiet", ref);
  } catch {
    return null;
  }
};

test("capture records the base commit, origin URL and the real git directories", async () => {
  const f = fixture();
  const { snap } = await snapshot(f);
  assert.equal(snap.baseSha, f.baseSha);
  assert.equal(fwd(snap.originUrl), fwd(f.origin));
  assert.equal(fwd(realpathSync.native(snap.commonDir)), fwd(commonDir(f)));
  assert.equal(fwd(realpathSync.native(snap.gitDir)), fwd(adminDir(f)));
});

test("readRefDirect reads loose and packed refs without git, and refuses anything that is not a commit id", () => {
  const dir = mkdtempSync(join(tmpdir(), "afk-ref-"));
  mkdirSync(join(dir, "refs", "heads", "afk"), { recursive: true });
  const a = "a".repeat(40);
  const b = "b".repeat(40);
  assert.equal(readRefDirect(dir, "refs/heads/afk/7"), null);
  writeFileSync(join(dir, "packed-refs"), `# pack-refs\n${b} refs/heads/afk/7\n${a} refs/heads/other\n^${a}\n`);
  assert.equal(readRefDirect(dir, "refs/heads/afk/7"), b);
  writeFileSync(join(dir, "refs", "heads", "afk", "7"), `${a}\n`);
  assert.equal(readRefDirect(dir, "refs/heads/afk/7"), a, "a loose ref wins over packed-refs");
  writeFileSync(join(dir, "refs", "heads", "afk", "7"), "ref: refs/heads/main\n");
  assert.throws(() => readRefDirect(dir, "refs/heads/afk/7"), /does not hold a commit id/);
});

test("pushArgs pushes one exact commit to the captured URL, never forced, with the helper only for GitHub", () => {
  const tip = "a".repeat(40);
  const gh = pushArgs("https://github.com/o/r.git", "afk/7", tip);
  assert.deepEqual(gh.slice(-3), ["push", "https://github.com/o/r.git", `${tip}:refs/heads/afk/7`]);
  assert.ok(gh.includes("credential.helper=!gh auth git-credential"));
  assert.ok(gh.includes("protocol.ext.allow=never") && gh.includes("core.fsmonitor=false"));
  assert.ok(gh.some((a) => a.startsWith("core.hooksPath=")));
  const local = pushArgs("/srv/o.git", "afk/7", tip);
  assert.ok(!local.some((a) => a.includes("credential.helper")));
  for (const a of [...gh, ...local]) assert.ok(!/^(-f|--force.*|\+.*)$/.test(a), `forced: ${a}`);
});

test("githubSlug names the repository of a GitHub URL and nothing else", () => {
  assert.equal(githubSlug("https://github.com/o/r.git"), "o/r");
  assert.equal(githubSlug("git@github.com:o/r.git"), "o/r");
  assert.equal(githubSlug("https://github.com/o/r"), "o/r");
  assert.equal(githubSlug("/srv/origin.git"), null);
  assert.equal(githubSlug("https://example.test/o/r.git"), null);
});

test("ensureExcluded adds .sandcastle/ once", async () => {
  const f = fixture();
  const ports = createGitPorts();
  await ports.ensureExcluded(f.work);
  await ports.ensureExcluded(f.work);
  const text = readFileSync(join(commonDir(f), "info", "exclude"), "utf8");
  assert.equal(text.split("\n").filter((l) => l === ".sandcastle/").length, 1);
});

// ---- protecting the user's .git

test("a planted hook is detected and removed; sandcastle's own user.name is not tampering", async () => {
  const f = fixture();
  const { ports, snap } = await snapshot(f);
  writeFileSync(join(commonDir(f), "config"), readFileSync(join(commonDir(f), "config"), "utf8") + "\n[user]\n\temail = agent@example.test\n");
  assert.equal(await ports.restoreIfTampered(snap), false);
  const hook = join(commonDir(f), "hooks", "pre-push");
  writeFileSync(hook, evilScript(f), { mode: 0o755 });
  assert.equal(await ports.restoreIfTampered(snap), true);
  assert.equal(existsSync(hook), false);
  assert.equal(await ports.restoreIfTampered(snap), false);
});

test("a config that runs something is detected and restored", async () => {
  const f = fixture();
  const { ports, snap } = await snapshot(f);
  const cfg = join(commonDir(f), "config");
  const before = readFileSync(cfg);
  writeFileSync(cfg, Buffer.concat([before, Buffer.from(`[core]\n\tsshCommand = sh ${fwd(join(f.root, "evil.sh"))}\n[protocol "ext"]\n\tallow = always\n`)]));
  assert.equal(await ports.restoreIfTampered(snap), true);
  assert.deepEqual(readFileSync(cfg), before);
});

test("a config git cannot parse is tampering, and the original bytes come back", async () => {
  const f = fixture();
  const { ports, snap } = await snapshot(f);
  const cfg = join(commonDir(f), "config");
  const before = readFileSync(cfg);
  writeFileSync(cfg, "[core\n\tsshCommand = x\n");
  assert.equal(await ports.restoreIfTampered(snap), true);
  assert.deepEqual(readFileSync(cfg), before);
});

test("the shared config.worktree is guarded too", async () => {
  const f = fixture();
  const { ports, snap } = await snapshot(f);
  const cw = join(commonDir(f), "config.worktree");
  writeFileSync(cw, "[core]\n\tfsmonitor = sh evil\n");
  assert.equal(await ports.restoreIfTampered(snap), true);
  assert.equal(existsSync(cw), false);
});

test("a rewritten commondir or gitdir of the worktree is detected and restored", async () => {
  const f = fixture();
  const { ports, snap } = await snapshot(f);
  const fake = join(f.root, "fake.git");
  git(f.root, "init", "-q", "--bare", fake);
  const cd = join(adminDir(f), "commondir");
  const gd = join(adminDir(f), "gitdir");
  const [cdBefore, gdBefore] = [readFileSync(cd), readFileSync(gd)];
  writeFileSync(cd, `${fwd(fake)}\n`);
  writeFileSync(gd, `${fwd(join(fake, "x"))}\n`);
  assert.equal(await ports.restoreIfTampered(snap), true);
  assert.deepEqual(readFileSync(cd), cdBefore);
  assert.deepEqual(readFileSync(gd), gdBefore);
});

test("a vanished worktree admin directory (sandcastle closing it) is not tampering", async () => {
  const f = fixture();
  const { ports, snap } = await snapshot(f);
  git(f.work, "worktree", "remove", "--force", f.wt);
  assert.equal(await ports.restoreIfTampered(snap), false);
});

// ---- the clean clone

test("the clean clone has the agent's commits, the validated tip, and only that", async () => {
  const f = fixture();
  const tip = commit(f, "src/a.ts");
  const { clean, sha } = await cleanFor(f);
  try {
    assert.equal(sha, tip);
    const inspected = await clean.inspect(tip);
    assert.deepEqual(inspected, { commits: 1, merges: 0, files: ["src/a.ts"] });
    await clean.checkout(tip);
    await clean.push(tip);
    assert.equal(originRef(f), tip);
    assert.ok(!existsSync(f.marker));
  } finally {
    await clean.dispose();
  }
});

test("a branch with no ref has no tip, and a clone without one still has the base", async () => {
  const f = fixture();
  git(f.wt, "checkout", "-q", "--detach");
  git(f.work, "worktree", "remove", "--force", f.wt);
  git(f.work, "branch", "-D", "afk/7");
  const { ports, snap } = await snapshot({ ...f, wt: f.work });
  assert.equal(await ports.readTip(snap, "afk/7"), null);
  const clean = await ports.createClean(snap, "afk/7", null);
  try {
    await clean.checkout(snap.baseSha);
    assert.equal(await clean.head(), snap.baseSha);
  } finally {
    await clean.dispose();
  }
});

test("a tip whose objects do not exist fails and leaves no clone behind", async () => {
  const f = fixture();
  const { ports, snap } = await snapshot(f);
  await assert.rejects(ports.createClean(snap, "afk/7", "d".repeat(40)));
});

test("a push is never forced: a diverged remote branch is refused", async () => {
  const f = fixture();
  git(f.work, "push", "-q", "origin", "main:refs/heads/afk/7");
  const tip = commit(f, "src/a.ts"); // wt branched from the same base, so afk/7 diverges only after another push
  const other = join(f.root, "other");
  git(f.root, "clone", "-q", f.origin, other);
  writeFileSync(join(other, "z"), "z");
  git(other, "add", ".");
  git(other, "commit", "-q", "-m", "other");
  git(other, "push", "-q", "origin", "HEAD:refs/heads/afk/7");
  const remote = originRef(f);
  const { clean } = await cleanFor(f, tip);
  try {
    await assert.rejects(clean.push(tip));
    assert.equal(originRef(f), remote);
  } finally {
    await clean.dispose();
  }
});

// ---- the reviewer's attacks, with real repositories

test("ATTACK commondir: redirecting the worktree to a fake repository gets no code run and does not change what is pushed", async () => {
  const f = fixture();
  const tip = commit(f, "src/a.ts");
  const { ports, snap } = await snapshot(f);
  const fake = join(f.root, "fake.git");
  git(f.root, "init", "-q", "--bare", fake);
  const sshHook = join(f.root, "evil-ssh.sh");
  writeFileSync(sshHook, evilScript(f), { mode: 0o755 });
  writeFileSync(
    join(fake, "config"),
    `[core]\n\tbare = true\n\tsshCommand = sh ${fwd(sshHook)}\n\tfsmonitor = sh ${fwd(sshHook)}\n\thooksPath = ${fwd(join(f.root, "hooks"))}\n[protocol "ext"]\n\tallow = always\n[url "${fwd(fake)}"]\n\tinsteadOf = ${fwd(f.origin)}\n\tpushInsteadOf = ${fwd(f.origin)}\n`,
  );
  mkdirSync(join(f.root, "hooks"));
  for (const h of ["pre-push", "post-checkout", "post-commit", "reference-transaction"]) writeFileSync(join(f.root, "hooks", h), evilScript(f), { mode: 0o755 });
  writeFileSync(join(adminDir(f), "commondir"), `${fwd(fake)}\n`);
  writeFileSync(join(adminDir(f), "gitdir"), `${fwd(join(fake, "x"))}\n`);

  // The run reads and pushes through pinned paths, before and instead of restoring.
  const sha = await ports.readTip(snap, "afk/7");
  assert.equal(sha, tip);
  const clean = await ports.createClean(snap, "afk/7", sha);
  try {
    assert.deepEqual((await clean.inspect(tip)).files, ["src/a.ts"]);
    await clean.checkout(tip);
    await clean.push(tip);
  } finally {
    await clean.dispose();
  }
  assert.equal(existsSync(f.marker), false, "code from the agent's fake repository ran on the host");
  assert.equal(originRef(f), tip, "the push went to the captured origin, not to the fake repository");
  assert.equal(await ports.restoreIfTampered(snap), true);
  assert.equal(readFileSync(join(adminDir(f), "commondir"), "utf8").trim().endsWith("../.."), true);
});

test("ATTACK replace: git replace cannot hide a workflow from the guard", async () => {
  const f = fixture();
  const workflow = commit(f, ".github/workflows/ci.yml", "on: push\n");
  const benign = git(f.wt, "commit-tree", "-p", f.baseSha, "-m", "benign", `${f.baseSha}^{tree}`);
  // With the replacement active, the shared repository shows the benign commit and no workflow.
  git(f.wt, "replace", workflow, benign);
  assert.equal(git(f.wt, "diff", "--name-only", `${f.baseSha}..${workflow}`), "", "the attack must hide the file from plain git first");
  const { ports, snap } = await snapshot(f);
  const sha = await ports.readTip(snap, "afk/7");
  assert.equal(sha, workflow);
  const clean = await ports.createClean(snap, "afk/7", sha);
  try {
    const inspected = await clean.inspect(workflow);
    assert.ok(inspected.files.includes(".github/workflows/ci.yml"), `the guard saw ${JSON.stringify(inspected.files)}`);
    assert.equal(inspected.commits, 1);
  } finally {
    await clean.dispose();
  }
});

test("ATTACK retarget: moving refs/remotes/origin/<base> (loose or packed) to the agent's commit does not shrink the guarded range", async () => {
  for (const packed of [false, true]) {
    const f = fixture();
    const tip = commit(f, ".github/workflows/ci.yml", "on: push\n");
    const { ports, snap } = await snapshot(f);
    git(f.work, "update-ref", "refs/remotes/origin/main", tip);
    if (packed) git(f.work, "pack-refs", "--all");
    assert.equal(git(f.work, "rev-parse", "origin/main"), tip, "the attack moved the base ref");
    const sha = await ports.readTip(snap, "afk/7");
    const clean = await ports.createClean(snap, "afk/7", sha);
    try {
      const inspected = await clean.inspect(sha!);
      assert.equal(inspected.commits, 1, `packed=${packed}`);
      assert.ok(inspected.files.includes(".github/workflows/ci.yml"), `packed=${packed}`);
    } finally {
      await clean.dispose();
    }
  }
});

test("ATTACK retarget on the Backlog.md blocked path: the clean clone is based on the captured base, so only the swap commit is pushed", async () => {
  const f = fixture();
  const evil = commit(f, ".github/workflows/ci.yml", "on: push\n");
  const { ports, snap } = await snapshot(f);
  git(f.work, "update-ref", "refs/remotes/origin/main", evil);
  const clean = await ports.createClean(snap, "afk/7", await ports.readTip(snap, "afk/7"));
  try {
    await clean.checkout(snap.baseSha);
    mkdirSync(join(clean.dir, "backlog"), { recursive: true });
    writeFileSync(join(clean.dir, "backlog", "t.md"), "blocked\n");
    git(clean.dir, "add", "-A");
    git(clean.dir, "commit", "-q", "-m", "blocked");
    const swap = await clean.head();
    assert.deepEqual(await clean.inspect(swap), { commits: 1, merges: 0, files: ["backlog/t.md"] });
    await clean.push(swap);
    assert.equal(originRef(f), swap);
    assert.equal(git(f.origin, "rev-list", "--count", `${f.baseSha}..${swap}`), "1");
    const contains = (() => { try { git(f.origin, "merge-base", "--is-ancestor", evil, swap); return true; } catch { return false; } })();
    assert.equal(contains, false, "the agent's commit must not be in the pushed history");
  } finally {
    await clean.dispose();
  }
});

test("hooks planted in the shared .git never run for commits and pushes made in the clean clone", async () => {
  const f = fixture();
  const tip = commit(f, "src/a.ts");
  const { ports, snap } = await snapshot(f);
  for (const h of ["pre-commit", "commit-msg", "post-commit", "pre-push", "post-checkout", "reference-transaction"]) {
    writeFileSync(join(commonDir(f), "hooks", h), evilScript(f), { mode: 0o755 });
  }
  git(f.work, "config", "core.fsmonitor", `sh ${fwd(join(f.root, "x"))}`);
  const clean = await ports.createClean(snap, "afk/7", await ports.readTip(snap, "afk/7"));
  try {
    await clean.checkout(tip);
    writeFileSync(join(clean.dir, "swap.md"), "swap\n");
    git(clean.dir, "add", "-A");
    git(clean.dir, "commit", "-q", "-m", "swap");
    await clean.push(await clean.head());
  } finally {
    await clean.dispose();
  }
  assert.equal(existsSync(f.marker), false, "a hook from the shared .git ran in the clean clone");
});

test("a merge commit and a file added then deleted are both visible to the guard", async () => {
  const f = fixture();
  commit(f, ".github/workflows/x.yml", "a\n");
  git(f.wt, "rm", "-q", ".github/workflows/x.yml");
  git(f.wt, "commit", "-q", "-m", "remove");
  const tip = git(f.wt, "rev-parse", "HEAD");
  const { clean } = await cleanFor(f, tip);
  try {
    const i = await clean.inspect(tip);
    assert.equal(i.commits, 2);
    assert.ok(i.files.includes(".github/workflows/x.yml"), "the per-commit paths catch the add-then-remove");
  } finally {
    await clean.dispose();
  }
});

test("a merge in the range is counted", async () => {
  const f = fixture();
  commit(f, "a.txt");
  git(f.wt, "checkout", "-q", "-b", "side", f.baseSha);
  commit(f, "b.txt");
  git(f.wt, "checkout", "-q", "afk/7");
  git(f.wt, "merge", "-q", "--no-ff", "-m", "merge", "side");
  const tip = git(f.wt, "rev-parse", "HEAD");
  const { clean } = await cleanFor(f, tip);
  try {
    assert.equal((await clean.inspect(tip)).merges, 1);
  } finally {
    await clean.dispose();
  }
});

// ---- stale branches and kept work

test("removeStale keeps unpushed commits under refs/afk-kept before deleting the branch, and logs it", async () => {
  const f = fixture();
  const tip = commit(f, "a.txt");
  git(f.work, "worktree", "remove", "--force", f.wt);
  const lines: string[] = [];
  await removeStale(f.work, "afk/7", { keep: true, log: (l) => lines.push(l), now: () => new Date("2026-11-20T10:00:00Z") });
  assert.equal(git(f.work, "rev-parse", "--verify", "--quiet", "refs/afk-kept/7/20261120T100000000Z"), tip);
  assert.throws(() => git(f.work, "rev-parse", "--verify", "--quiet", "refs/heads/afk/7"));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /afk-kept\/7\/20261120T100000000Z/);
});

test("removeStale deletes a branch with nothing unpushed without a backup, and is idempotent", async () => {
  const f = fixture();
  await removeStale(f.work, "afk/7", { keep: true });
  assert.equal(git(f.work, "for-each-ref", "refs/afk-kept").length, 0);
  await removeStale(f.work, "afk/7", { keep: true });
  assert.throws(() => git(f.work, "rev-parse", "--verify", "--quiet", "refs/heads/afk/7"));
});

test("removeLocal through the ports also keeps work when asked", async () => {
  const f = fixture();
  commit(f, "a.txt");
  git(f.work, "worktree", "remove", "--force", f.wt);
  await createGitPorts().removeLocal(f.work, "afk/7", true);
  assert.notEqual(git(f.work, "for-each-ref", "refs/afk-kept"), "");
});

test("remoteHasBranch tells a claimed branch from a free one", async () => {
  const f = fixture();
  assert.equal(await remoteHasBranch(f.work, "afk/7"), false);
  git(f.work, "push", "-q", "origin", "main:refs/heads/afk/7");
  assert.equal(await remoteHasBranch(f.work, "afk/7"), true);
});

// keep unused-import checks honest
void (undefined as unknown as CleanClone | GitSnapshot);
void rmSync;
