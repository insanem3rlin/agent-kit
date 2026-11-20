import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { run } from "../src/cli.ts";
import { loadConfig } from "../src/config.ts";
import { initRepo } from "../src/init.ts";

function repo(branch?: string): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "afk-init-")));
  if (branch) execFileSync("git", ["init", "-q", "-b", branch, dir]);
  return dir;
}

test("init writes a valid config.json and a Dockerfile, and nothing else", () => {
  const dir = repo("trunk");
  initRepo(dir);
  assert.deepEqual(readdirSync(join(dir, ".afk")).sort(), ["Dockerfile", "config.json"]);
  const config = loadConfig(dir);
  assert.equal(config.baseBranch, "main"); // no main/master and no remote: the current branch is never used
  assert.equal(config.label, "afk");
  assert.equal(config.backlog, "github");
  assert.equal(config.concurrency, 1);
});

test("init writes at the repository root when run from a subdirectory", () => {
  const dir = repo("main");
  const sub = join(dir, "pkg", "deep");
  mkdirSync(sub, { recursive: true });
  const { dir: written } = initRepo(sub);
  assert.equal(existsSync(join(dir, ".afk", "config.json")), true);
  assert.equal(existsSync(join(sub, ".afk")), false);
  assert.equal(realpathSync.native(written), realpathSync.native(join(dir, ".afk")));
});

test("init refuses outside a git work tree and writes nothing", () => {
  const dir = repo();
  assert.throws(() => initRepo(dir), /git/);
  assert.equal(existsSync(join(dir, ".afk")), false);
});

test("init takes the base branch from the default branch, not the current one", () => {
  const dir = repo("master");
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "x"], { cwd: dir });
  execFileSync("git", ["checkout", "-q", "-b", "feature/x"], { cwd: dir });
  assert.equal(initRepo(dir).config.baseBranch, "master");
});

test("the Dockerfile installs agent-kit and the plugins inside the image", () => {
  const dir = repo("main");
  initRepo(dir);
  const text = readFileSync(join(dir, ".afk", "Dockerfile"), "utf8");
  assert.match(text, /^FROM node:22/m);
  assert.match(text, /git clone .*agent-kit/);
  assert.match(text, /^ARG AGENT_KIT_REF=main$/m);
  assert.match(text, /checkout .*AGENT_KIT_REF/);
  assert.match(text, /--no-timer/);
  assert.match(text, /^ARG AGENT_HOME=\/home\/agent$/m);
  assert.match(text, /install\.sh/);
  assert.match(text, /@openai\/codex/);
  assert.match(text, /cursor\.com\/install/);
  assert.match(text, /ENTRYPOINT \["sleep", "infinity"\]/);
  // A failed kit install must fail the build; only the plugin step may fail softly.
  assert.doesNotMatch(text, /\|\| echo/);
  assert.match(text, /test -s ~\/\.claude\/CLAUDE\.md/);
  assert.match(text, /test -s ~\/\.codex\/AGENTS\.md/);
  assert.match(text, /test -s ~\/\.claude\/agents\/reviewer\.md/);
  assert.match(text, /test -s ~\/\.claude\/skills\/do-issue\/SKILL\.md/);
  assert.match(text, /test -s ~\/\.agents\/skills\/do-issue\/SKILL\.md/);
  assert.doesNotMatch(text, /^(COPY|ADD) /m);
  assert.doesNotMatch(text, /VOLUME/);
});

test("nothing the init writes holds a secret-shaped value", () => {
  const dir = repo("main");
  initRepo(dir);
  for (const f of ["Dockerfile", "config.json"]) {
    const text = readFileSync(join(dir, ".afk", f), "utf8");
    assert.doesNotMatch(text, /(sk-|ghp_|github_pat_)[A-Za-z0-9]/);
    assert.doesNotMatch(text, /TOKEN=|API_KEY=/);
  }
});

test("init refuses to overwrite an existing .afk and leaves it untouched", () => {
  const dir = repo("main");
  mkdirSync(join(dir, ".afk"));
  writeFileSync(join(dir, ".afk", "config.json"), "mine");
  assert.throws(() => initRepo(dir), /already exists/);
  assert.equal(readFileSync(join(dir, ".afk", "config.json"), "utf8"), "mine");
  assert.equal(existsSync(join(dir, ".afk", "Dockerfile")), false);
});

test("the cli routes `init` to the scaffold, in the given directory", async () => {
  const dir = repo("main");
  let out = "";
  assert.equal(await run(["init"], (t) => (out += t), dir), 0);
  assert.match(out, /\.afk/);
  assert.equal(loadConfig(dir).implementer, "claude");
  out = "";
  assert.equal(await run(["init"], (t) => (out += t), dir), 1);
  assert.match(out, /already exists/);
});
