import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { run, USAGE } from "../src/cli.ts";

async function capture(argv: string[], cwd?: string): Promise<{ code: number; out: string }> {
  let out = "";
  const code = await run(argv, (t) => (out += t), cwd);
  return { code, out };
}

const tmp = () => mkdtempSync(join(tmpdir(), "afk-cli-"));

function gitRepo(): string {
  const dir = tmp();
  execFileSync("git", ["init", "-q", dir]);
  return dir;
}

const CONFIG = { backlog: "github", label: "afk", baseBranch: "main", implementer: "claude", reviewer: "claude", concurrency: 1 };

async function withConfigDir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const before = process.env.AGENT_KIT_CONFIG;
  process.env.AGENT_KIT_CONFIG = dir;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.AGENT_KIT_CONFIG;
    else process.env.AGENT_KIT_CONFIG = before;
  }
}

test("--help prints the usage and succeeds", async () => {
  assert.deepEqual(await capture(["--help"]), { code: 0, out: USAGE });
  assert.equal((await capture(["-h"])).code, 0);
});

test("outside a git repository the daemon prints one line and exits 1", async () => {
  const r = await capture([], tmp());
  assert.equal(r.code, 1);
  assert.match(r.out, /^agent-kit afk: .*git repository.*\n$/);
});

test("without .afk/config.json the daemon prints one line and exits 1", async () => {
  const r = await capture([], gitRepo());
  assert.equal(r.code, 1);
  assert.match(r.out, /^agent-kit afk: .*config.*\n$/);
  assert.equal(r.out.trim().split("\n").length, 1);
});

test("without afk.env the daemon prints one line and exits 1", async () => {
  const repo = gitRepo();
  mkdirSync(join(repo, ".afk"));
  writeFileSync(join(repo, ".afk", "config.json"), JSON.stringify(CONFIG));
  const r = await withConfigDir(tmp(), () => capture([], repo));
  assert.equal(r.code, 1);
  assert.match(r.out, /^agent-kit afk: .*afk\.env not found.*\n$/);
});

test("missing secrets are one line and exit 1", async () => {
  const repo = gitRepo();
  mkdirSync(join(repo, ".afk"));
  writeFileSync(join(repo, ".afk", "config.json"), JSON.stringify(CONFIG));
  const cfg = tmp();
  writeFileSync(join(cfg, "afk.env"), "SOMETHING=1\n");
  const r = await withConfigDir(cfg, () => capture([], repo));
  assert.equal(r.code, 1);
  assert.match(r.out, /^agent-kit afk: .*GH_TOKEN.*\n$/);
});
