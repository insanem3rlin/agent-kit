import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { run } from "../src/cli.ts";
import { loadConfig } from "../src/config.ts";
import { detectBaseBranch, initRepo } from "../src/init.ts";

function repo(branch?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "afk-init-"));
  if (branch) execFileSync("git", ["init", "-q", "-b", branch, dir]);
  return dir;
}

test("init writes a valid config.json and a Dockerfile, and nothing else", () => {
  const dir = repo("trunk");
  initRepo(dir);
  assert.deepEqual(readdirSync(join(dir, ".afk")).sort(), ["Dockerfile", "config.json"]);
  const config = loadConfig(dir);
  assert.equal(config.baseBranch, "trunk");
  assert.equal(config.label, "afk");
  assert.equal(config.backlog, "github");
  assert.equal(config.concurrency, 1);
});

test("init falls back to main outside a git repository", () => {
  const dir = repo();
  assert.equal(detectBaseBranch(dir), "main");
  assert.equal(initRepo(dir).config.baseBranch, "main");
});

test("the Dockerfile installs agent-kit and the plugins inside the image", () => {
  const dir = repo();
  initRepo(dir);
  const text = readFileSync(join(dir, ".afk", "Dockerfile"), "utf8");
  assert.match(text, /^FROM node:22/m);
  assert.match(text, /git clone .*agent-kit/);
  assert.match(text, /install\.sh/);
  assert.match(text, /@openai\/codex/);
  assert.match(text, /cursor\.com\/install/);
  assert.match(text, /ENTRYPOINT \["sleep", "infinity"\]/);
  assert.doesNotMatch(text, /^(COPY|ADD) /m);
  assert.doesNotMatch(text, /VOLUME/);
});

test("nothing the init writes holds a secret-shaped value", () => {
  const dir = repo();
  initRepo(dir);
  for (const f of ["Dockerfile", "config.json"]) {
    const text = readFileSync(join(dir, ".afk", f), "utf8");
    assert.doesNotMatch(text, /(sk-|ghp_|github_pat_)[A-Za-z0-9]/);
    assert.doesNotMatch(text, /TOKEN=|API_KEY=/);
  }
});

test("init refuses to overwrite an existing .afk and leaves it untouched", () => {
  const dir = repo();
  mkdirSync(join(dir, ".afk"));
  writeFileSync(join(dir, ".afk", "config.json"), "mine");
  assert.throws(() => initRepo(dir), /already exists/);
  assert.equal(readFileSync(join(dir, ".afk", "config.json"), "utf8"), "mine");
  assert.equal(existsSync(join(dir, ".afk", "Dockerfile")), false);
});

test("the cli routes `init` to the scaffold, in the given directory", () => {
  const dir = repo("main");
  let out = "";
  assert.equal(run(["init"], (t) => (out += t), dir), 0);
  assert.match(out, /\.afk/);
  assert.equal(loadConfig(dir).implementer, "claude");
  out = "";
  assert.equal(run(["init"], (t) => (out += t), dir), 1);
  assert.match(out, /already exists/);
});
