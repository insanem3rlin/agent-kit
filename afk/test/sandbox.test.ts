import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SetupError } from "../src/run.ts";
import { dockerBuildArgs, draftPrArgs, imageNameFor, kitCommit } from "../src/sandbox.ts";

test("the image build passes the kit commit as AGENT_KIT_REF", () => {
  const args = dockerBuildArgs({ imageName: "afk-r", repoDir: "/r", kitRef: "abc123", uid: 1000, gid: 1000 });
  assert.ok(args.includes("AGENT_KIT_REF=abc123"));
  assert.equal(args[args.indexOf("--tag") + 1], "afk-r");
});

test("the image name is a valid tag", () => {
  assert.equal(imageNameFor("/srv/work/My Repo"), "afk-my-repo");
});

test("the PR is a draft against the base branch, body from stdin", () => {
  const args = draftPrArgs({ head: "afk/7", base: "main", title: "T" });
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
  assert.deepEqual(lines, []);
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
