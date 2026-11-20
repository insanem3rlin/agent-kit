// runIssue with the real git ports on real temp repositories. Only Docker, the agents and
// GitHub are fake: the "agent" is a function that does what a hostile one could do to the
// run clone it is given.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Backlog, BacklogIssue } from "../src/backlog/types.ts";
import type { AfkConfig } from "../src/config.ts";
import { createGitPorts } from "../src/hostgit.ts";
import { SetupError, runIssue } from "../src/run.ts";
import type { RunOutcome, RunPorts } from "../src/run.ts";
import { fixture, fwd, git, treeHash } from "./gitfix.ts";
import type { Fixture } from "./gitfix.ts";

const config: AfkConfig = { backlog: "github", label: "afk", baseBranch: "main", implementer: "claude", reviewer: "claude", concurrency: 1 };
const env = { GH_TOKEN: "gh-token", ANTHROPIC_API_KEY: "a-key" }; // leak-check: allow

/** The run clone, its git directory and the worktree sandcastle made for the branch. */
type Agent = (a: { runDir: string; commonDir: string; wt: string }) => void;

function drive(f: Fixture, agent: Agent, o: { id?: string } = {}) {
  const id = o.id ?? "7";
  const issue: BacklogIssue = { id, title: `Issue ${id}`, body: "body", url: `https://example.test/${id}` };
  const seen = { runDirs: [] as string[], blocked: [] as string[], ready: [] as string[], logs: [] as string[] };
  const backlog: Backlog = {
    listReady: async () => [],
    listRejected: async () => [],
    markReadyForHuman: async (_id, text) => void seen.ready.push(text),
    markBlocked: async (_id, reason) => void seen.blocked.push(reason),
    comment: async () => {},
  };
  const ports: RunPorts = {
    async openSandbox({ branch, runDir }) {
      seen.runDirs.push(runDir);
      const wt = join(runDir, ".sandcastle", "worktrees", branch.replace("/", "-"));
      git(runDir, "worktree", "add", "-q", "-b", branch, wt, "origin/main");
      let ran = false;
      return {
        async runAgent(r) {
          if (ran || !r.name.endsWith("implementer")) return;
          ran = true;
          agent({ runDir, commonDir: join(runDir, ".git"), wt });
        },
        readFile: async () => null,
        removeFile: async () => {},
        close: async () => {},
      };
    },
    git: createGitPorts(),
    github: { createDraftPr: async () => "https://github.test/o/r/pull/1", commentOnPr: async () => {} },
    readText: (p) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
  };
  const run = (): Promise<RunOutcome> => runIssue({ issue, config, env, repoDir: f.user, github: false, backlog, ports, log: (l) => seen.logs.push(l) });
  return { run, seen };
}

const commitIn = (wt: string, file: string, content = "x\n") => {
  mkdirSync(join(wt, file, ".."), { recursive: true });
  writeFileSync(join(wt, file), content);
  git(wt, "add", "-A");
  git(wt, "commit", "-q", "-m", `add ${file}`);
  return git(wt, "rev-parse", "HEAD");
};
const originRef = (f: Fixture, ref = "refs/heads/afk/7") => {
  try {
    return git(f.origin, "rev-parse", "--verify", "--quiet", ref);
  } catch {
    return null;
  }
};
const evil = (f: Fixture) => `#!/bin/sh\necho ran > "${fwd(f.marker)}"\n`;

test("a clean run pushes the agent's commit, and the user's .git is byte-identical afterwards even though the agent attacked the run clone", async () => {
  const f = fixture();
  const before = treeHash(join(f.user, ".git"));
  let tip = "";
  const { run, seen } = drive(f, ({ commonDir, wt }) => {
    tip = commitIn(wt, "src/a.ts");
    for (const h of ["pre-push", "post-commit", "reference-transaction", "post-checkout"]) writeFileSync(join(commonDir, "hooks", h), evil(f), { mode: 0o755 });
    writeFileSync(join(commonDir, "config"), `${readFileSync(join(commonDir, "config"), "utf8")}[core]\n\tsshCommand = sh ${fwd(f.marker)}\n\tfsmonitor = sh ${fwd(f.marker)}\n`);
    writeFileSync(join(commonDir, "worktrees", "afk-7", "commondir"), `${fwd(join(f.user, ".git"))}\n`);
    writeFileSync(join(commonDir, "worktrees", "afk-7", "gitdir"), `${fwd(join(f.user, ".git", "x"))}\n`);
  });
  const out = await run();
  assert.equal(out.status, "ready");
  assert.equal(originRef(f), tip);
  assert.equal(existsSync(f.marker), false);
  assert.equal(treeHash(join(f.user, ".git")), before, "the user's repository was touched");
  assert.equal(existsSync(seen.runDirs[0]), false, "the run clone is deleted");
});

test("the user's repository is not fetched or written either when the run is blocked", async () => {
  const f = fixture();
  const before = treeHash(join(f.user, ".git"));
  const { run } = drive(f, () => {}); // no commits
  const out = await run();
  assert.equal(out.status, "blocked");
  assert.equal(treeHash(join(f.user, ".git")), before);
});

test("chained alternates: a tree that references a host-only blob blocks the run (not a SetupError) and pushes nothing", async () => {
  const f = fixture();
  const hostRepo = join(f.root, "host");
  git(f.root, "init", "-q", hostRepo);
  writeFileSync(join(hostRepo, "secret.txt"), "private host data\n");
  const secret = git(hostRepo, "hash-object", "-w", "secret.txt");
  const { run, seen } = drive(f, ({ commonDir, wt }) => {
    writeFileSync(join(commonDir, "objects", "info", "alternates"), `${fwd(join(hostRepo, ".git", "objects"))}\n`);
    git(wt, "update-index", "--add", "--cacheinfo", `100644,${secret},secret.txt`);
    git(wt, "commit", "-q", "-m", "x");
  });
  const out = await run();
  assert.equal(out.status, "blocked");
  assert.match((out as { reason: string }).reason, /cannot be imported/);
  assert.equal(originRef(f), null);
  assert.equal(seen.blocked.length, 1);
});

test("a tip whose objects are missing blocks the issue", async () => {
  const f = fixture();
  const { run } = drive(f, ({ commonDir }) => {
    mkdirSync(join(commonDir, "refs", "heads", "afk"), { recursive: true });
    writeFileSync(join(commonDir, "refs", "heads", "afk", "7"), `${"d".repeat(40)}\n`);
  });
  const out = await run();
  assert.equal(out.status, "blocked");
  assert.match((out as { reason: string }).reason, /cannot be imported/);
  assert.equal(originRef(f), null);
});

test("a ref that is not a commit id blocks the issue", async () => {
  const f = fixture();
  const { run } = drive(f, ({ commonDir }) => {
    mkdirSync(join(commonDir, "refs", "heads", "afk"), { recursive: true });
    writeFileSync(join(commonDir, "refs", "heads", "afk", "7"), "ref: refs/heads/main\n");
  });
  const out = await run();
  assert.equal(out.status, "blocked");
});

test("a read-only run clone cannot make runIssue throw", async () => {
  const f = fixture();
  let dirs: string[] = [];
  const { run, seen } = drive(f, ({ runDir, wt }) => {
    commitIn(wt, "src/a.ts");
    const all = readdirSync(runDir, { recursive: true, withFileTypes: true }).map((e) => join(e.parentPath, e.name));
    for (const p of all.reverse()) chmodSync(p, 0o444);
    chmodSync(runDir, 0o555);
    dirs = all;
  });
  const out = await run();
  assert.ok(out.status === "ready" || out.status === "blocked");
  for (const p of [seen.runDirs[0], ...dirs]) {
    try {
      chmodSync(p, 0o777); // tidy up whatever the failed delete left
    } catch {
      /* already gone */
    }
  }
});

test("two runs on the same repository get distinct run clones and both finish", async () => {
  const f = fixture();
  const a = drive(f, ({ wt }) => void commitIn(wt, "a.txt"), { id: "7" });
  const b = drive(f, ({ wt }) => void commitIn(wt, "b.txt"), { id: "8" });
  const [x, y] = await Promise.all([a.run(), b.run()]);
  assert.equal(x.status, "ready");
  assert.equal(y.status, "ready");
  assert.notEqual(a.seen.runDirs[0], b.seen.runDirs[0]);
  assert.ok(originRef(f, "refs/heads/afk/7") && originRef(f, "refs/heads/afk/8"));
});

test("the run clone is kept, with its path in the outcome and the log, when origin rejects the push", async () => {
  const f = fixture();
  writeFileSync(join(f.origin, "hooks", "pre-receive"), "#!/bin/sh\necho no >&2\nexit 1\n", { mode: 0o755 });
  const { run, seen } = drive(f, ({ wt }) => void commitIn(wt, "a.txt"));
  const out = await run();
  assert.equal(out.status, "blocked");
  const kept = (out as { keptClone?: string }).keptClone;
  assert.equal(kept, seen.runDirs[0]);
  assert.ok(existsSync(kept!));
  assert.ok(seen.logs.some((l) => l.includes(kept!)));
  assert.equal(git(kept!, "rev-list", "--count", "origin/main..afk/7"), "1", "the agent's work is still in the kept clone");
});

test("a workflow change hidden with git replace in the run clone is still refused", async () => {
  const f = fixture();
  const { run } = drive(f, ({ wt }) => {
    const wf = commitIn(wt, ".github/workflows/ci.yml", "on: push\n");
    const benign = git(wt, "commit-tree", "-p", f.baseSha, "-m", "benign", `${f.baseSha}^{tree}`);
    git(wt, "replace", wf, benign);
  });
  const out = await run();
  assert.equal(out.status, "blocked");
  assert.match((out as { reason: string }).reason, /workflows/);
  assert.equal(originRef(f), null);
});

test("a workflow change with origin/<base> moved onto it in the run clone is still refused", async () => {
  const f = fixture();
  const { run } = drive(f, ({ runDir, wt }) => {
    const wf = commitIn(wt, ".github/workflows/ci.yml", "on: push\n");
    git(runDir, "update-ref", "refs/remotes/origin/main", wf);
    git(runDir, "pack-refs", "--all");
  });
  const out = await run();
  assert.equal(out.status, "blocked");
  assert.equal(originRef(f), null);
});

test("an origin that cannot be cloned is a SetupError and no sandbox starts", async () => {
  const f = fixture();
  git(f.user, "remote", "set-url", "origin", join(f.root, "nowhere.git"));
  const { run, seen } = drive(f, () => {});
  await assert.rejects(run(), SetupError);
  assert.deepEqual(seen.runDirs, []);
});
