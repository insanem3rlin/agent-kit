import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dockerBuildArgs, draftPrArgs, imageNameFor, pushArgs } from "../src/sandbox.ts";

test("the image build passes the kit commit as AGENT_KIT_REF", () => {
  const args = dockerBuildArgs({ imageName: "afk-r", repoDir: "/r", kitRef: "abc123", uid: 1000, gid: 1000 });
  assert.ok(args.includes("AGENT_KIT_REF=abc123"));
  assert.equal(args[args.indexOf("--tag") + 1], "afk-r");
});

test("the image name is a valid tag", () => {
  assert.equal(imageNameFor("/srv/work/My Repo"), "afk-my-repo");
});

test("push targets exactly the run's branch and never forces", () => {
  const args = pushArgs("afk/7");
  assert.ok(args.includes("refs/heads/afk/7:refs/heads/afk/7"));
  assert.ok(!args.some((a) => a.startsWith("--force") || a === "-f" || a.startsWith("+")));
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
