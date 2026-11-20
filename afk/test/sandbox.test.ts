import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SetupError } from "../src/run.ts";
import { dockerBuildArgs, draftPrArgs, imageNameFor, isIssueSpecificSetupFailure, kitCommit } from "../src/sandbox.ts";

test("the image build passes the kit commit as AGENT_KIT_REF", () => {
  const args = dockerBuildArgs({ imageName: "afk-r", repoDir: "/r", kitRef: "abc123", uid: 1000, gid: 1000 });
  assert.ok(args.includes("AGENT_KIT_REF=abc123"));
  assert.equal(args[args.indexOf("--tag") + 1], "afk-r");
});

test("the image name is a valid tag", () => {
  assert.equal(imageNameFor("/srv/work/My Repo"), "afk-my-repo");
});

test("the PR is a draft against the base branch, body from stdin", () => {
  const args = draftPrArgs({ repo: "o/r", head: "afk/7", base: "main", title: "T" });
  assert.equal(args[args.indexOf("--repo") + 1], "o/r");
  assert.ok(args.includes("--draft"));
  assert.equal(args[args.indexOf("--base") + 1], "main");
  assert.equal(args[args.indexOf("--head") + 1], "afk/7");
  assert.equal(args[args.indexOf("--body-file") + 1], "-");
});

test("the Dockerfile still declares the build arg the launcher passes", () => {
  assert.match(readFileSync(new URL("../templates/Dockerfile", import.meta.url), "utf8"), /^ARG AGENT_KIT_REF=/m);
});

const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", ...a], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

test("the kit commit baked into the image is one the remote has, and a local-only commit is logged", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "afk-kit-")));
  git(root, "init", "-q", "--bare", "-b", "main", join(root, "o.git"));
  git(root, "clone", "-q", join(root, "o.git"), join(root, "kit"));
  const kit = join(root, "kit");
  writeFileSync(join(kit, "f"), "1");
  git(kit, "add", ".");
  git(kit, "commit", "-q", "-m", "one");
  git(kit, "push", "-q", "-u", "origin", "HEAD:main");
  const pushed = git(kit, "rev-parse", "HEAD");
  const lines: string[] = [];
  assert.equal(await kitCommit(kit, (l) => lines.push(l)), pushed);
  assert.equal(lines.length, 0);
  writeFileSync(join(kit, "f"), "2");
  git(kit, "commit", "-qam", "local only");
  assert.equal(await kitCommit(kit, (l) => lines.push(l)), pushed);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /newest commit its upstream has/);
});

test("a kit checkout without an upstream is a SetupError", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "afk-kit-")));
  git(root, "init", "-q", "-b", "main", root);
  writeFileSync(join(root, "f"), "1");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "one");
  await assert.rejects(kitCommit(root), SetupError);
});

test("only the two exact sandcastle messages are issue-specific setup failures", () => {
  assert.equal(isIssueSpecificSetupFailure("Branch 'afk/7' is already checked out in worktree at '/srv/w'."), true);
  assert.equal(isIssueSpecificSetupFailure("Branch 'afk/7' is already checked out in another worktree."), true);
  assert.equal(isIssueSpecificSetupFailure("fatal: '/srv/r/.sandcastle/worktrees/afk-7' already exists"), true);
  for (const m of ["worktree add failed: no space left on device", "fatal: not a git repository", "docker: Cannot connect to the Docker daemon", "branch protection already exists", "git worktree is locked"]) {
    assert.equal(isIssueSpecificSetupFailure(m), false, m);
  }
});
