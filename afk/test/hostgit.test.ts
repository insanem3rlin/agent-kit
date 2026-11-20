import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ImportError, createGitPorts, githubSlug, pushArgs, readRefDirect, remoteHasBranch } from "../src/hostgit.ts";
import type { RunClone } from "../src/hostgit.ts";
import { fixture, fwd, git, treeHash } from "./gitfix.ts";
import type { Fixture } from "./gitfix.ts";

/** What sandcastle does inside the run clone: a linked worktree on afk/7. */
function agentWorktree(run: RunClone) {
  const wt = join(run.dir, ".sandcastle", "worktrees", "afk-7");
  git(run.dir, "worktree", "add", "-q", "-b", "afk/7", wt, "origin/main");
  return wt;
}

const commit = (wt: string, file: string, content = "x\n") => {
  mkdirSync(join(wt, file, ".."), { recursive: true });
  writeFileSync(join(wt, file), content);
  git(wt, "add", "-A");
  git(wt, "commit", "-q", "-m", `add ${file}`);
  return git(wt, "rev-parse", "HEAD");
};

const evilScript = (f: Fixture) => `#!/bin/sh\necho ran > "${fwd(f.marker)}"\n`;
const originRef = (f: Fixture, ref = "refs/heads/afk/7") => {
  try {
    return git(f.origin, "rev-parse", "--verify", "--quiet", ref);
  } catch {
    return null;
  }
};

async function started(f: Fixture) {
  const ports = createGitPorts();
  const run = await ports.createRunClone(await ports.originUrl(f.user), "main", "7");
  return { ports, run, wt: agentWorktree(run) };
}

test("originUrl reads the URL of origin without running anything from the repository", async () => {
  const f = fixture();
  writeFileSync(join(f.user, ".git", "hooks", "reference-transaction"), evilScript(f), { mode: 0o755 });
  assert.equal(fwd(await createGitPorts().originUrl(f.user)), fwd(f.origin));
  assert.equal(existsSync(f.marker), false);
});

test("the run clone is a private, full copy of origin in the temp directory, at origin/<base>", async () => {
  const f = fixture();
  const ports = createGitPorts();
  const url = await ports.originUrl(f.user);
  const a = await ports.createRunClone(url, "main", "7");
  const b = await ports.createRunClone(url, "main", "7");
  try {
    assert.notEqual(a.dir, b.dir);
    assert.ok(fwd(a.dir).startsWith(fwd(realpathSync.native(tmpdir()))) || fwd(a.dir).startsWith(fwd(tmpdir())));
    assert.match(a.dir, /afk-run-7-/);
    assert.equal(a.baseSha, f.baseSha);
    assert.equal(a.originUrl, url);
    assert.equal(git(a.dir, "rev-parse", "HEAD"), f.baseSha);
    assert.equal(fwd(realpathSync.native(a.commonDir)), fwd(realpathSync.native(join(a.dir, ".git"))));
    assert.equal(existsSync(join(a.commonDir, "objects", "info", "alternates")), false, "no sharing with the user's repository");
  } finally {
    await a.dispose();
    await b.dispose();
  }
  assert.equal(existsSync(a.dir), false);
});

test("a clone of a local origin shares no objects with the user's repository (no hardlinks)", async () => {
  const f = fixture();
  const { run } = await started(f);
  try {
    const seen = (dir: string): string[] => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
    for (const p of seen(join(run.commonDir, "objects"))) assert.equal(lstatSync(p).nlink, 1, p);
  } finally {
    await run.dispose();
  }
});

test("the user's repository is byte-identical after a whole run in which the agent attacks the run clone", async () => {
  const f = fixture();
  const before = treeHash(join(f.user, ".git"));
  const ports = createGitPorts();
  const run = await ports.createRunClone(await ports.originUrl(f.user), "main", "7");
  const wt = agentWorktree(run);
  const tip = commit(wt, "src/a.ts");
  // the agent plants hooks, config and a commondir redirect in the run clone
  for (const h of ["pre-push", "post-commit", "reference-transaction"]) writeFileSync(join(run.commonDir, "hooks", h), evilScript(f), { mode: 0o755 });
  writeFileSync(join(run.commonDir, "config"), readFileSync(join(run.commonDir, "config"), "utf8") + `[core]\n\tsshCommand = sh ${fwd(join(f.root, "x"))}\n\tfsmonitor = sh ${fwd(join(f.root, "x"))}\n`);
  writeFileSync(join(run.commonDir, "worktrees", "afk-7", "commondir"), `${fwd(join(f.user, ".git"))}\n`);
  writeFileSync(join(run.commonDir, "worktrees", "afk-7", "gitdir"), `${fwd(join(f.user, ".git", "x"))}\n`);
  const clean = await ports.createClean(run, "afk/7", await run.readTip("afk/7"));
  await clean.checkout(tip);
  await clean.push(tip);
  await clean.dispose();
  await run.dispose();
  assert.equal(treeHash(join(f.user, ".git")), before);
  assert.equal(originRef(f), tip);
  assert.equal(existsSync(f.marker), false);
});

test("readTip reads the ref files directly, loose or packed, and refuses anything that is not a commit id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "afk-ref-"));
  mkdirSync(join(dir, "refs", "heads", "afk"), { recursive: true });
  const a = "a".repeat(40);
  const b = "b".repeat(40);
  assert.equal(readRefDirect(dir, "refs/heads/afk/7"), null);
  writeFileSync(join(dir, "packed-refs"), `# pack-refs\n${b} refs/heads/afk/7\n${a} refs/heads/other\n^${a}\n`);
  assert.equal(readRefDirect(dir, "refs/heads/afk/7"), b);
  writeFileSync(join(dir, "refs", "heads", "afk", "7"), `${a}\n`);
  assert.equal(readRefDirect(dir, "refs/heads/afk/7"), a);
  writeFileSync(join(dir, "refs", "heads", "afk", "7"), "ref: refs/heads/main\n");
  assert.throws(() => readRefDirect(dir, "refs/heads/afk/7"), /does not hold a commit id/);
});

test("the run clone's tip is read from loose and packed refs; an unborn branch has none", async () => {
  const f = fixture();
  const { run, wt } = await started(f);
  try {
    const tip = commit(wt, "a.txt");
    assert.equal(await run.readTip("afk/7"), tip);
    git(run.dir, "pack-refs", "--all");
    assert.equal(await run.readTip("afk/7"), tip);
    assert.equal(await run.readTip("afk/99"), null);
  } finally {
    await run.dispose();
  }
});

test("with a reftable run clone the tip comes from a hardened git command pinned to the clone", async (t) => {
  const f = fixture();
  const ports = createGitPorts();
  let run: RunClone;
  try {
    const url = await ports.originUrl(f.user);
    const probe = join(f.root, "probe");
    execFileSync("git", ["init", "-q", "--ref-format=reftable", probe]);
    run = await ports.createRunClone(url, "main", "7");
  } catch {
    t.skip("this git cannot make reftable repositories");
    return;
  }
  try {
    const wt = agentWorktree(run);
    const tip = commit(wt, "a.txt");
    // convert the run clone to reftable the way an agent (or a user's init.defaultRefFormat) could
    git(run.dir, "refs", "migrate", "--ref-format=reftable");
    assert.match(readFileSync(join(run.commonDir, "config"), "utf8"), /refstorage\s*=\s*reftable/i);
    assert.equal(await run.readTip("afk/7"), tip);
  } catch (e) {
    if (/refs migrate|ref-format/.test(String(e))) t.skip("this git cannot migrate refs");
    else throw e;
  } finally {
    await run.dispose();
  }
});

test("pushArgs pushes one exact commit to the captured URL, never forced, with the helper only for GitHub", () => {
  const tip = "a".repeat(40);
  const gh = pushArgs("https://github.com/o/r.git", "afk/7", tip);
  assert.deepEqual(gh.slice(-3), ["push", "https://github.com/o/r.git", `${tip}:refs/heads/afk/7`]);
  assert.ok(gh.includes("credential.helper=!gh auth git-credential"));
  assert.ok(gh.includes("protocol.ext.allow=never") && gh.includes("core.fsmonitor=false"));
  const local = pushArgs("/srv/o.git", "afk/7", tip);
  assert.ok(!local.some((a) => a.includes("credential.helper")));
  for (const a of [...gh, ...local]) assert.ok(!/^(-f|--force.*|\+.*)$/.test(a), `forced: ${a}`);
});

test("githubSlug names the repository of a GitHub URL and nothing else", () => {
  assert.equal(githubSlug("https://github.com/o/r.git"), "o/r");
  assert.equal(githubSlug("git@github.com:o/r.git"), "o/r");
  assert.equal(githubSlug("/srv/origin.git"), null);
});

// ---- the clean clone and the import

test("the clean clone has the agent's commits, and the guards see exactly what would be pushed", async () => {
  const f = fixture();
  const { ports, run, wt } = await started(f);
  const tip = commit(wt, "src/a.ts");
  const clean = await ports.createClean(run, "afk/7", await run.readTip("afk/7"));
  try {
    assert.deepEqual(await clean.inspect(tip), { commits: 1, merges: 0, files: ["src/a.ts"] });
    await clean.checkout(tip);
    await clean.push(tip);
    assert.equal(originRef(f), tip);
  } finally {
    await clean.dispose();
    await run.dispose();
  }
});

test("a push is never forced: a diverged remote branch is refused", async () => {
  const f = fixture();
  const { ports, run, wt } = await started(f);
  const tip = commit(wt, "src/a.ts");
  const other = join(f.root, "other");
  git(f.root, "clone", "-q", f.origin, other);
  writeFileSync(join(other, "z"), "z");
  git(other, "add", ".");
  git(other, "commit", "-q", "-m", "other");
  git(other, "push", "-q", "origin", "HEAD:refs/heads/afk/7");
  const remote = originRef(f);
  const clean = await ports.createClean(run, "afk/7", tip);
  try {
    await assert.rejects(clean.push(tip));
    assert.equal(originRef(f), remote);
  } finally {
    await clean.dispose();
    await run.dispose();
  }
});

test("ATTACK commondir: a worktree redirected to a fake repository, with its config, gets no code run and does not change what is pushed", async () => {
  const f = fixture();
  const { ports, run, wt } = await started(f);
  const tip = commit(wt, "src/a.ts");
  const fake = join(f.root, "fake.git");
  git(f.root, "init", "-q", "--bare", fake);
  const sshHook = join(f.root, "evil-ssh.sh");
  writeFileSync(sshHook, evilScript(f), { mode: 0o755 });
  mkdirSync(join(f.root, "hooks"));
  for (const h of ["pre-push", "post-checkout", "post-commit", "reference-transaction"]) writeFileSync(join(f.root, "hooks", h), evilScript(f), { mode: 0o755 });
  writeFileSync(
    join(fake, "config"),
    `[core]\n\tbare = true\n\tsshCommand = sh ${fwd(sshHook)}\n\tfsmonitor = sh ${fwd(sshHook)}\n\thooksPath = ${fwd(join(f.root, "hooks"))}\n[protocol "ext"]\n\tallow = always\n[url "${fwd(fake)}"]\n\tinsteadOf = ${fwd(f.origin)}\n\tpushInsteadOf = ${fwd(f.origin)}\n`,
  );
  writeFileSync(join(run.commonDir, "worktrees", "afk-7", "commondir"), `${fwd(fake)}\n`);
  writeFileSync(join(run.commonDir, "worktrees", "afk-7", "gitdir"), `${fwd(join(fake, "x"))}\n`);
  const clean = await ports.createClean(run, "afk/7", await run.readTip("afk/7"));
  try {
    assert.deepEqual((await clean.inspect(tip)).files, ["src/a.ts"]);
    await clean.checkout(tip);
    await clean.push(tip);
  } finally {
    await clean.dispose();
    await run.dispose();
  }
  assert.equal(existsSync(f.marker), false);
  assert.equal(originRef(f), tip);
});

test("ATTACK replace: git replace cannot hide a workflow from the guard", async () => {
  const f = fixture();
  const { ports, run, wt } = await started(f);
  const workflow = commit(wt, ".github/workflows/ci.yml", "on: push\n");
  const benign = git(wt, "commit-tree", "-p", f.baseSha, "-m", "benign", `${f.baseSha}^{tree}`);
  git(wt, "replace", workflow, benign);
  assert.equal(git(wt, "diff", "--name-only", `${f.baseSha}..${workflow}`), "", "the attack must hide the file from plain git first");
  const clean = await ports.createClean(run, "afk/7", await run.readTip("afk/7"));
  try {
    assert.ok((await clean.inspect(workflow)).files.includes(".github/workflows/ci.yml"));
  } finally {
    await clean.dispose();
    await run.dispose();
  }
});

test("ATTACK retarget: moving origin/<base> in the run clone, loose or packed, does not shrink the guarded range", async () => {
  for (const packed of [false, true]) {
    const f = fixture();
    const { ports, run, wt } = await started(f);
    const tip = commit(wt, ".github/workflows/ci.yml", "on: push\n");
    git(run.dir, "update-ref", "refs/remotes/origin/main", tip);
    if (packed) git(run.dir, "pack-refs", "--all");
    const clean = await ports.createClean(run, "afk/7", await run.readTip("afk/7"));
    try {
      const i = await clean.inspect(tip);
      assert.equal(i.commits, 1, `packed=${packed}`);
      assert.ok(i.files.includes(".github/workflows/ci.yml"));
    } finally {
      await clean.dispose();
      await run.dispose();
    }
  }
});

test("ATTACK retarget on the Backlog.md blocked path: only the captured base and the swap commit are pushed", async () => {
  const f = fixture();
  const { ports, run, wt } = await started(f);
  const evil = commit(wt, ".github/workflows/ci.yml", "on: push\n");
  git(run.dir, "update-ref", "refs/remotes/origin/main", evil);
  const clean = await ports.createClean(run, "afk/7", await run.readTip("afk/7"));
  try {
    await clean.checkout(run.baseSha);
    writeFileSync(join(clean.dir, "t.md"), "blocked\n");
    git(clean.dir, "add", "-A");
    git(clean.dir, "commit", "-q", "-m", "blocked");
    const swap = await clean.head();
    assert.deepEqual(await clean.inspect(swap), { commits: 1, merges: 0, files: ["t.md"] });
    await clean.push(swap);
    assert.equal(originRef(f), swap);
    assert.equal(git(f.origin, "rev-list", "--count", `${f.baseSha}..${swap}`), "1");
    assert.throws(() => git(f.origin, "merge-base", "--is-ancestor", evil, swap));
  } finally {
    await clean.dispose();
    await run.dispose();
  }
});

test("hooks planted in the run clone never run for commits and pushes made in the clean clone", async () => {
  const f = fixture();
  const { ports, run, wt } = await started(f);
  const tip = commit(wt, "src/a.ts");
  for (const h of ["pre-commit", "commit-msg", "post-commit", "pre-push", "post-checkout", "reference-transaction"]) writeFileSync(join(run.commonDir, "hooks", h), evilScript(f), { mode: 0o755 });
  const clean = await ports.createClean(run, "afk/7", tip);
  try {
    await clean.checkout(tip);
    writeFileSync(join(clean.dir, "swap.md"), "swap\n");
    git(clean.dir, "add", "-A");
    git(clean.dir, "commit", "-q", "-m", "swap");
    await clean.push(await clean.head());
  } finally {
    await clean.dispose();
    await run.dispose();
  }
  assert.equal(existsSync(f.marker), false);
});

test("a file added in one commit and removed in the next is still visible to the guard", async () => {
  const f = fixture();
  const { ports, run, wt } = await started(f);
  commit(wt, ".github/workflows/x.yml", "a\n");
  git(wt, "rm", "-q", ".github/workflows/x.yml");
  git(wt, "commit", "-q", "-m", "remove");
  const tip = git(wt, "rev-parse", "HEAD");
  const clean = await ports.createClean(run, "afk/7", tip);
  try {
    const i = await clean.inspect(tip);
    assert.equal(i.commits, 2);
    assert.ok(i.files.includes(".github/workflows/x.yml"));
  } finally {
    await clean.dispose();
    await run.dispose();
  }
});

test("a merge in the range is counted", async () => {
  const f = fixture();
  const { ports, run, wt } = await started(f);
  commit(wt, "a.txt");
  git(wt, "checkout", "-q", "-b", "side", f.baseSha);
  commit(wt, "b.txt");
  git(wt, "checkout", "-q", "afk/7");
  git(wt, "merge", "-q", "--no-ff", "-m", "merge", "side");
  const tip = git(wt, "rev-parse", "HEAD");
  const clean = await ports.createClean(run, "afk/7", tip);
  try {
    assert.equal((await clean.inspect(tip)).merges, 1);
  } finally {
    await clean.dispose();
    await run.dispose();
  }
});

// ---- D3, D4: what the import refuses

test("ATTACK chained alternates: pointing the run clone at a host repository's objects does not import the host's private blob", async () => {
  const f = fixture();
  const hostRepo = join(f.root, "host");
  git(f.root, "init", "-q", hostRepo);
  writeFileSync(join(hostRepo, "secret.txt"), "private host data\n");
  const secret = git(hostRepo, "hash-object", "-w", "secret.txt");
  const { ports, run, wt } = await started(f);
  writeFileSync(join(run.commonDir, "objects", "info", "alternates"), `${fwd(join(hostRepo, ".git", "objects"))}\n`);
  git(wt, "update-index", "--add", "--cacheinfo", `100644,${secret},secret.txt`);
  git(wt, "commit", "-q", "-m", "reference a blob that only the host has");
  const tip = git(wt, "rev-parse", "HEAD");
  await assert.rejects(ports.createClean(run, "afk/7", tip), (e) => e instanceof ImportError);
  assert.equal(originRef(f), null);
  await run.dispose();
});

test("an alternates file inside the object directory is never carried over", async () => {
  const f = fixture();
  const { ports, run, wt } = await started(f);
  const tip = commit(wt, "a.txt");
  writeFileSync(join(run.commonDir, "objects", "info", "alternates"), `${fwd(join(f.user, ".git", "objects"))}\n`);
  const clean = await ports.createClean(run, "afk/7", tip);
  try {
    assert.equal(existsSync(join(clean.dir, ".git", "objects", "info", "alternates")), false);
  } finally {
    await clean.dispose();
    await run.dispose();
  }
});

test("a tip whose objects do not exist is an ImportError and leaves no clone behind", async () => {
  const f = fixture();
  const { ports, run } = await started(f);
  const before = readdirSync(tmpdir()).filter((n) => n.startsWith("afk-clean-")).length;
  await assert.rejects(ports.createClean(run, "afk/7", "d".repeat(40)), (e) => e instanceof ImportError);
  assert.equal(readdirSync(tmpdir()).filter((n) => n.startsWith("afk-clean-")).length, before);
  await run.dispose();
});

test("a symlink in the object store (a pack that points at host data) is an ImportError", async (t) => {
  const f = fixture();
  const { ports, run, wt } = await started(f);
  const tip = commit(wt, "a.txt");
  const hostPack = join(f.user, ".git", "objects", "pack");
  mkdirSync(hostPack, { recursive: true });
  try {
    symlinkSync(hostPack, join(run.commonDir, "objects", "pack", "evil"), "dir");
  } catch {
    t.skip("cannot create symlinks here");
    await run.dispose();
    return;
  }
  await assert.rejects(ports.createClean(run, "afk/7", tip), (e) => e instanceof ImportError);
  await run.dispose();
});

test("an object store over the size limit is an ImportError", async () => {
  const f = fixture();
  const { run, wt } = await started(f);
  const tip = commit(wt, "a.txt");
  const small = createGitPorts(process.env, () => {}, { maxImportBytes: 10 });
  await assert.rejects(small.createClean(run, "afk/7", tip), (e) => e instanceof ImportError);
  await run.dispose();
});

test("failing to fetch the base from origin is not an ImportError", async () => {
  const f = fixture();
  const { ports, run, wt } = await started(f);
  const tip = commit(wt, "a.txt");
  const gone: RunClone = { ...run, originUrl: join(f.root, "nowhere.git") };
  await assert.rejects(ports.createClean(gone, "afk/7", tip), (e) => !(e instanceof ImportError));
  await run.dispose();
});

test("remoteHasBranch tells a claimed branch from a free one", async () => {
  const f = fixture();
  assert.equal(await remoteHasBranch(f.user, "afk/7"), false);
  git(f.user, "push", "-q", "origin", "main:refs/heads/afk/7");
  assert.equal(await remoteHasBranch(f.user, "afk/7"), true);
});
