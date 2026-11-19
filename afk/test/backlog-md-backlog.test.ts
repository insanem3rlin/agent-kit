import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BacklogError } from "../src/backlog/types.ts";
import { createBacklogMdBacklog, defaultGit } from "../src/backlog/backlog-md.ts";
import type { Git } from "../src/backlog/backlog-md.ts";

function g(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

interface TaskSpec {
  id: string;
  title?: string;
  status?: string;
  labels?: string[];
  deps?: string[];
  body?: string;
  eol?: string;
}

function taskFile(t: TaskSpec): string {
  const list = (key: string, items: string[]) => (items.length === 0 ? [`${key}: []`] : [`${key}:`, ...items.map((i) => `  - ${i}`)]);
  const lines = [
    "---",
    `id: ${t.id}`,
    `title: ${t.title ?? "Title " + t.id}`,
    `status: ${t.status ?? "To Do"}`,
    "assignee: []",
    "created_date: '2025-09-17 19:19'",
    ...list("labels", t.labels ?? []),
    ...list("dependencies", t.deps ?? []),
    "---",
    "",
    "## Description",
    "",
    t.body ?? `Body of ${t.id}`,
    "",
  ];
  return lines.join(t.eol ?? "\n");
}

function put(dir: string, path: string, content: string): void {
  const full = join(dir, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

interface Fixture {
  root: string;
  remote: string;
  repo: string;
  /** Commits task files (path to content) on main in a scratch clone and pushes. */
  publish(files: Record<string, string>): void;
  /** A checkout on the run's branch afk/<id>, branched off the remote main. */
  checkout(id: string): string;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "afk-bmd-"));
  const remote = join(root, "remote.git");
  g(root, "init", "--bare", "--initial-branch=main", remote);
  const identity = (dir: string) => {
    g(dir, "config", "user.name", "Test");
    g(dir, "config", "user.email", "test@example.invalid");
    g(dir, "config", "commit.gpgsign", "false");
    g(dir, "config", "core.autocrlf", "false");
  };
  const repo = join(root, "repo");
  g(root, "clone", "-q", "-c", "core.autocrlf=false", remote, repo);
  identity(repo);
  g(repo, "checkout", "-q", "-B", "main");
  let n = 0;
  const publish = (files: Record<string, string>) => {
    for (const [p, c] of Object.entries(files)) put(repo, p, c);
    g(repo, "add", "-A");
    g(repo, "commit", "-q", "-m", `commit ${++n}`);
    g(repo, "push", "-q", "origin", "main");
  };
  const checkout = (id: string) => {
    const dir = join(root, `run-${id}`);
    g(root, "clone", "-q", "-c", "core.autocrlf=false", remote, dir);
    identity(dir);
    g(dir, "checkout", "-q", "-b", `afk/${id}`, "origin/main");
    return dir;
  };
  return { root, remote, repo, publish, checkout };
}

const T = (n: number) => `backlog/tasks/task-${n} - Title.md`;

function bl(f: Fixture, extra: Partial<Parameters<typeof createBacklogMdBacklog>[0]> = {}) {
  return createBacklogMdBacklog({ repoDir: f.repo, label: "afk", remote: "origin", baseBranch: "main", ...extra });
}

test("a task is ready with the AFK label, status not Done and every dependency Done", async () => {
  const f = fixture();
  f.publish({
    [T(1)]: taskFile({ id: "task-1", labels: ["afk"] }),
    [T(2)]: taskFile({ id: "task-2", labels: ["afk"], deps: ["task-3"] }),
    [T(3)]: taskFile({ id: "task-3", status: "Done" }),
    [T(4)]: taskFile({ id: "task-4", labels: ["afk"], deps: ["task-5"] }),
    [T(5)]: taskFile({ id: "task-5", status: "In Progress" }),
    [T(6)]: taskFile({ id: "task-6", labels: ["other"] }),
    [T(7)]: taskFile({ id: "task-7", labels: ["afk"], status: "Done" }),
  });
  const ready = await bl(f).listReady();
  assert.deepEqual(ready.map((i) => i.id), ["task-1", "task-2"]);
  assert.equal(ready[0].title, "Title task-1");
  assert.match(ready[0].body, /Body of task-1/);
  assert.equal(ready[0].url, "backlog/tasks/task-1 - Title.md");
});

test("an unknown dependency counts as open; a dependency under completed/ counts as Done", async () => {
  const f = fixture();
  f.publish({
    [T(1)]: taskFile({ id: "task-1", labels: ["afk"], deps: ["task-99"] }),
    [T(2)]: taskFile({ id: "task-2", labels: ["afk"], deps: ["TASK-8"] }),
    "backlog/completed/task-8 - Old.md": taskFile({ id: "task-8", status: "Done" }),
  });
  assert.deepEqual((await bl(f).listReady()).map((i) => i.id), ["task-2"]);
});

test("a Done task under archive/tasks satisfies a dependency; an archived task that is not Done does not", async () => {
  const f = fixture();
  f.publish({
    [T(1)]: taskFile({ id: "task-1", labels: ["afk"], deps: ["task-8"] }),
    [T(2)]: taskFile({ id: "task-2", labels: ["afk"], deps: ["task-9"] }),
    "backlog/archive/tasks/task-8 - Old.md": taskFile({ id: "task-8", status: "Done" }),
    "backlog/archive/tasks/task-9 - Cancelled.md": taskFile({ id: "task-9", status: "To Do" }),
  });
  assert.deepEqual((await bl(f).listReady()).map((i) => i.id), ["task-1"]);
});

test("archived and completed tasks are never ready, even with the label", async () => {
  const f = fixture();
  f.publish({
    "backlog/archive/tasks/task-8 - Old.md": taskFile({ id: "task-8", status: "To Do", labels: ["afk"] }),
    "backlog/completed/task-9 - Old.md": taskFile({ id: "task-9", status: "To Do", labels: ["afk"] }),
  });
  assert.deepEqual(await bl(f).listReady(), []);
  assert.deepEqual(await bl(f).listRejected(), []);
});

test("a duplicate id across tasks and archive/tasks fails closed", async () => {
  const f = fixture();
  f.publish({
    [T(1)]: taskFile({ id: "task-1", labels: ["afk"] }),
    "backlog/archive/tasks/task-1 - Dup.md": taskFile({ id: "task-1", status: "Done" }),
  });
  await assert.rejects(bl(f).listReady(), /duplicate/i);
});

test("Done is the last status in backlog/config.yml of the base branch, compared case-insensitively", async () => {
  const f = fixture();
  f.publish({
    "backlog/config.yml": 'project_name: "P"\nstatuses: ["To Do", "In Progress", "Shipped"]\nlabels: []\n',
    [T(1)]: taskFile({ id: "task-1", labels: ["afk"], deps: ["task-2", "task-3"] }),
    [T(2)]: taskFile({ id: "task-2", status: "shipped" }),
    [T(3)]: taskFile({ id: "task-3", status: "Done" }),
    [T(4)]: taskFile({ id: "task-4", labels: ["afk"], deps: ["task-2"] }),
    [T(5)]: taskFile({ id: "task-5", labels: ["afk"], status: "Shipped" }),
  });
  assert.deepEqual((await bl(f).listReady()).map((i) => i.id), ["task-4"]);
});

test("the final status can be a block list in config.yml; without a config it is Done", async () => {
  const f = fixture();
  f.publish({
    "backlog/config.yml": "statuses:\n  - To Do\n  - 'Released'\n# comment\ndefault_status: To Do\n",
    [T(1)]: taskFile({ id: "task-1", labels: ["afk"], deps: ["task-2"] }),
    [T(2)]: taskFile({ id: "task-2", status: "Released" }),
  });
  assert.deepEqual((await bl(f).listReady()).map((i) => i.id), ["task-1"]);
  const f2 = fixture();
  f2.publish({
    [T(1)]: taskFile({ id: "task-1", labels: ["afk"], deps: ["task-2"] }),
    [T(2)]: taskFile({ id: "task-2", status: "DONE" }),
  });
  assert.deepEqual((await bl(f2).listReady()).map((i) => i.id), ["task-1"]);
});

test("a root backlog.config.yml decides the final status and wins over backlog/config.yml", async () => {
  const f = fixture();
  f.publish({
    "backlog.config.yml": 'statuses: ["To Do", "Done", "Released"]\n',
    [T(1)]: taskFile({ id: "task-1", labels: ["afk"], deps: ["task-2"] }),
    [T(2)]: taskFile({ id: "task-2", status: "Done" }),
    [T(3)]: taskFile({ id: "task-3", labels: ["afk"], deps: ["task-4"] }),
    [T(4)]: taskFile({ id: "task-4", status: "Released" }),
  });
  assert.deepEqual((await bl(f).listReady()).map((i) => i.id), ["task-3"]);
  const f2 = fixture();
  f2.publish({
    "backlog.config.yml": 'statuses: ["To Do", "Shipped"]\n',
    "backlog/config.yml": 'statuses: ["To Do", "Done"]\n',
    [T(1)]: taskFile({ id: "task-1", labels: ["afk"], deps: ["task-2"] }),
    [T(2)]: taskFile({ id: "task-2", status: "Shipped" }),
  });
  assert.deepEqual((await bl(f2).listReady()).map((i) => i.id), ["task-1"]);
});

test("an unreadable config.yml fails closed", async () => {
  const f = fixture();
  f.publish({ "backlog/config.yml": "statuses: nonsense\n", [T(1)]: taskFile({ id: "task-1", labels: ["afk"] }) });
  await assert.rejects(bl(f).listReady(), BacklogError);
  const f2 = fixture();
  f2.publish({ "backlog/config.yml": "statuses: []\n", [T(1)]: taskFile({ id: "task-1", labels: ["afk"] }) });
  await assert.rejects(bl(f2).listReady(), BacklogError);
});

test("ids compare after normalising zero-padding and case", async () => {
  const f = fixture();
  f.publish({
    [T(1)]: taskFile({ id: "BACK-001.02", labels: ["afk"], deps: ["back-3", "BACK-0010.1"] }),
    [T(3)]: taskFile({ id: "BACK-003", status: "Done" }),
    [T(10)]: taskFile({ id: "BACK-10.01", status: "Done" }),
    [T(4)]: taskFile({ id: "BACK-4", labels: ["afk"], deps: ["BACK-1.2"] }),
  });
  assert.deepEqual((await bl(f).listReady()).map((i) => i.id), ["BACK-001.02"]);
  // BACK-001.02 and BACK-1.2 are one id: a second file with it is a duplicate.
  const f2 = fixture();
  f2.publish({
    [T(1)]: taskFile({ id: "BACK-1.2", labels: ["afk"] }),
    [T(2)]: taskFile({ id: "BACK-001.02" }),
  });
  await assert.rejects(bl(f2).listReady(), /duplicate/i);
  // A claim branch with another padding still claims the task.
  const f3 = fixture();
  f3.publish({ [T(1)]: taskFile({ id: "BACK-001", labels: ["afk"] }) });
  g(f3.repo, "push", "-q", "origin", "main:refs/heads/afk/BACK-1");
  assert.deepEqual(await bl(f3).listReady(), []);
});

test("fetch and ls-remote run in no-prompt mode; local git calls do not", async () => {
  const f = fixture();
  f.publish({ [T(1)]: taskFile({ id: "task-1", labels: ["afk"] }) });
  const seen: { args: string[]; remote?: boolean }[] = [];
  const recording: Git = async (args, opts) => {
    seen.push({ args, remote: opts?.remote });
    return execFileSync("git", args, { cwd: opts?.cwd, encoding: "utf8" });
  };
  await bl(f, { git: recording }).listReady();
  for (const s of seen) {
    const network = s.args[0] === "fetch" || s.args[0] === "ls-remote";
    assert.equal(s.remote === true, network, s.args.join(" "));
  }
  assert.ok(seen.some((s) => s.args[0] === "fetch") && seen.some((s) => s.args[0] === "ls-remote"));
});

test("the default git runs remote calls without prompts", async () => {
  const root = mkdtempSync(join(tmpdir(), "afk-bmd-env-"));
  g(root, "init", "-q");
  // echo, not printenv: BSD printenv (macOS) takes a single name.
  const probe = ["-c", 'alias.probe=!echo "$GIT_TERMINAL_PROMPT,$GCM_INTERACTIVE"', "probe"];
  const out = await defaultGit(probe, { cwd: root, remote: true });
  assert.equal(out.trim(), "0,never");
});

test("a task with an afk/<id> branch on the remote is claimed and not ready", async () => {
  const f = fixture();
  f.publish({
    [T(1)]: taskFile({ id: "task-1", labels: ["afk"] }),
    [T(2)]: taskFile({ id: "task-2", labels: ["afk"] }),
  });
  g(f.repo, "push", "-q", "origin", "main:refs/heads/afk/task-2");
  g(f.repo, "push", "-q", "origin", "main:refs/heads/feature/task-1");
  assert.deepEqual((await bl(f).listReady()).map((i) => i.id), ["task-1"]);
});

test("tasks are read from the remote base branch, not from the checkout", async () => {
  const f = fixture();
  f.publish({ [T(1)]: taskFile({ id: "task-1", labels: ["afk"] }) });
  // Local, unpushed edits and a local-only branch must not change the answer.
  put(f.repo, T(2), taskFile({ id: "task-2", labels: ["afk"] }));
  put(f.repo, T(1), taskFile({ id: "task-1", labels: [] }));
  g(f.repo, "checkout", "-q", "-b", "afk/task-1");
  assert.deepEqual((await bl(f).listReady()).map((i) => i.id), ["task-1"]);
  // A push to the remote shows up on the next call (it fetches).
  const other = f.checkout("task-9");
  put(other, T(3), taskFile({ id: "task-3", labels: ["afk"] }));
  g(other, "add", "-A");
  g(other, "commit", "-q", "-m", "x");
  g(other, "push", "-q", "origin", "HEAD:main");
  assert.deepEqual((await bl(f).listReady()).map((i) => i.id), ["task-1", "task-3"]);
});

test("the configured label and its agent-override prefix are used", async () => {
  const f = fixture();
  f.publish({
    [T(1)]: taskFile({ id: "task-1", labels: ["go", "go:codex"] }),
    [T(2)]: taskFile({ id: "task-2", labels: ["afk"] }),
  });
  const ready = await bl(f, { label: "go" }).listReady();
  assert.deepEqual(ready.map((i) => [i.id, i.agent]), [["task-1", "codex"]]);
});

test("an unknown or conflicting override is rejected, not ready, and listRejected has no side effects", async () => {
  const f = fixture();
  f.publish({
    [T(1)]: taskFile({ id: "task-1", labels: ["afk", "afk:gpt"] }),
    [T(2)]: taskFile({ id: "task-2", labels: ["afk", "afk:claude", "afk:codex"] }),
    [T(3)]: taskFile({ id: "task-3", labels: ["afk", "afk:cursor"] }),
    [T(4)]: taskFile({ id: "task-4", labels: ["afk", "afk:gpt"], deps: ["task-50"] }),
  });
  const b = bl(f);
  assert.deepEqual((await b.listReady()).map((i) => [i.id, i.agent]), [["task-3", "cursor"]]);
  const rejected = await b.listRejected();
  assert.deepEqual(rejected.map((r) => r.id), ["task-1", "task-2"]);
  assert.match(rejected[0].reason, /afk:gpt/);
  assert.match(rejected[1].reason, /conflicting/);
  assert.equal(g(f.repo, "status", "--porcelain"), "");
});

test("YAML variants: flow lists, quoted values, unindented items and CRLF all parse", async () => {
  const f = fixture();
  f.publish({
    [T(1)]: '---\nid: "task-1"\ntitle: \'It\'\'s: fine\'\nstatus: To Do\nlabels: ["afk", \'x, y\']\ndependencies: ["task-2", task-3]\n---\n\nbody\n',
    [T(2)]: "---\nid: task-2\ntitle: T\nstatus: Done\nlabels:\n- a\ndependencies: []\n---\n",
    [T(3)]: taskFile({ id: "task-3", status: "Done", eol: "\r\n" }),
    [T(4)]: taskFile({ id: "task-4", labels: ["afk"], eol: "\r\n" }),
  });
  const ready = await bl(f).listReady();
  assert.deepEqual(ready.map((i) => i.id), ["task-1", "task-4"]);
  assert.equal(ready[0].title, "It's: fine");
});

test("fails closed on an unparseable task file, a duplicate id, a git error or a bad id", async () => {
  const f = fixture();
  f.publish({ [T(1)]: taskFile({ id: "task-1", labels: ["afk"] }) });
  f.publish({ [T(2)]: "no frontmatter here\n" });
  await assert.rejects(bl(f).listReady(), BacklogError);

  const f2 = fixture();
  f2.publish({ [T(1)]: taskFile({ id: "task-1", labels: ["afk"] }), "backlog/completed/task-1 - Dup.md": taskFile({ id: "task-1", status: "Done" }) });
  await assert.rejects(bl(f2).listReady(), /duplicate/i);

  const f3 = fixture();
  f3.publish({ [T(1)]: "---\nid: task-1\nstatus: To Do\nlabels: afk\n---\n" });
  await assert.rejects(bl(f3).listReady(), BacklogError);

  const f4 = fixture();
  f4.publish({ [T(1)]: taskFile({ id: "../evil", labels: ["afk"] }) });
  await assert.rejects(bl(f4).listReady(), BacklogError);

  const f5 = fixture();
  f5.publish({ [T(1)]: taskFile({ id: "task-1", labels: ["afk"] }) });
  const broken: Git = async (args, opts) => {
    if (args[0] === "ls-remote") throw new Error("network down");
    return execFileSync("git", args, { cwd: opts?.cwd, encoding: "utf8" });
  };
  await assert.rejects(bl(f5, { git: broken }).listReady(), BacklogError);
  await assert.rejects(bl(f5, { remote: "nowhere" }).listReady(), BacklogError);
});

test("markReadyForHuman commits the label swap and the comment on the run's branch only", async () => {
  const f = fixture();
  f.publish({ [T(1)]: taskFile({ id: "task-1", labels: ["keep", "afk", "afk:codex"] }) });
  const baseBefore = g(f.remote, "rev-parse", "main");
  const wd = f.checkout("task-1");
  const b = bl(f);
  await b.markReadyForHuman("task-1", "PR: https://example.invalid/pull/1", { workdir: wd });
  const text = readFileSync(join(wd, T(1)), "utf8");
  assert.match(text, /labels:\n {2}- keep\n {2}- afk:codex\n {2}- ready-for-human\n/);
  assert.doesNotMatch(text, /- afk\n/);
  assert.match(text, /## AFK comments/);
  assert.match(text, /PR: https:\/\/example.invalid\/pull\/1/);
  assert.match(text, /Body of task-1/);
  assert.equal(g(wd, "log", "--format=%s", "origin/main..HEAD").split("\n").length, 1);
  assert.equal(g(wd, "status", "--porcelain"), "");
  assert.equal(g(f.remote, "rev-parse", "main"), baseBefore);
  assert.equal(g(f.remote, "branch", "--list", "afk/*"), "");
});

test("markBlocked swaps to afk-blocked and records the reason; repeating it does not duplicate the label", async () => {
  const f = fixture();
  f.publish({ [T(1)]: taskFile({ id: "task-1", labels: ["afk"] }) });
  const wd = f.checkout("task-1");
  const b = bl(f);
  await b.markBlocked("task-1", "tests never went green", { workdir: wd });
  await b.markBlocked("task-1", "second reason", { workdir: wd });
  const text = readFileSync(join(wd, T(1)), "utf8");
  assert.equal(text.match(/- afk-blocked/g)?.length, 1);
  assert.doesNotMatch(text, /- afk\n/);
  assert.match(text, /tests never went green/);
  assert.match(text, /second reason/);
  assert.equal(text.match(/## AFK comments/g)?.length, 1);
});

test("the swap handles flow lists and a task without a labels field, and keeps CRLF", async () => {
  const f = fixture();
  f.publish({
    [T(1)]: '---\nid: task-1\ntitle: T\nstatus: To Do\nlabels: [afk, "a b"]\n---\nbody\n',
    [T(2)]: "---\nid: task-2\ntitle: T\nstatus: To Do\n---\nbody\n",
    [T(3)]: taskFile({ id: "task-3", labels: ["afk"], eol: "\r\n" }),
  });
  const w1 = f.checkout("task-1");
  await bl(f).markReadyForHuman("task-1", "c", { workdir: w1 });
  assert.match(readFileSync(join(w1, T(1)), "utf8"), /labels:\n {2}- 'a b'\n {2}- ready-for-human\n/);
  const w2 = f.checkout("task-2");
  await bl(f).markBlocked("task-2", "c", { workdir: w2 });
  assert.match(readFileSync(join(w2, T(2)), "utf8"), /labels:\n {2}- afk-blocked\n---\n/);
  const w3 = f.checkout("task-3");
  await bl(f).markBlocked("task-3", "c", { workdir: w3 });
  assert.doesNotMatch(readFileSync(join(w3, T(3)), "utf8").replace(/\r\n/g, ""), /\n/);
});

test("the swap and comment refuse without a workdir, on another branch, or for an unknown task, and commit nothing", async () => {
  const f = fixture();
  f.publish({ [T(1)]: taskFile({ id: "task-1", labels: ["afk"] }) });
  const b = bl(f);
  await assert.rejects(b.markReadyForHuman("task-1", "c"), BacklogError);
  await assert.rejects(b.markBlocked("task-1", "c", {}), BacklogError);
  await assert.rejects(b.comment("task-1", "c"), BacklogError);
  const wd = f.checkout("task-1");
  g(wd, "checkout", "-q", "main");
  await assert.rejects(b.markBlocked("task-1", "c", { workdir: wd }), /afk\/task-1/);
  g(wd, "checkout", "-q", "afk/task-1");
  await assert.rejects(b.markBlocked("task-2", "c", { workdir: wd }), BacklogError);
  await assert.rejects(b.markBlocked("../x", "c", { workdir: wd }), BacklogError);
  assert.equal(g(wd, "rev-list", "--count", "origin/main..HEAD"), "0");
  assert.equal(g(f.remote, "rev-list", "--count", "main"), "1");
});

test("comment with a workdir appends a note and commits it on the run's branch", async () => {
  const f = fixture();
  f.publish({ [T(1)]: taskFile({ id: "task-1", labels: ["afk"] }) });
  const wd = f.checkout("task-1");
  await bl(f).comment("task-1", "Spec finding: x\n\nsecond paragraph", { workdir: wd });
  const text = readFileSync(join(wd, T(1)), "utf8");
  assert.match(text, /Spec finding: x\n\nsecond paragraph/);
  assert.match(text, /- afk\n/);
  assert.equal(g(wd, "rev-list", "--count", "origin/main..HEAD"), "1");
});
