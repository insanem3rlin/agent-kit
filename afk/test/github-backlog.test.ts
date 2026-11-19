import assert from "node:assert/strict";
import { test } from "node:test";
import { createGithubBacklog } from "../src/backlog/github.ts";
import { spawnGh } from "../src/backlog/github.ts";
import type { Gh } from "../src/backlog/github.ts";

type Call = { args: string[]; input?: string };

// A fake gh: `routes` maps a prefix of the argument list to a reply (or a thrown error).
function fakeGh(routes: Record<string, string | Error>): { gh: Gh; calls: Call[] } {
  const calls: Call[] = [];
  const gh: Gh = async (args, input) => {
    calls.push({ args, input });
    const key = Object.keys(routes).find((k) => args.join(" ").startsWith(k));
    if (key === undefined) return "";
    const reply = routes[key];
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { gh, calls };
}

function issue(
  number: number,
  labels: string[],
  blockedBy: { state: string; url?: string }[] = [],
  extra: Record<string, unknown> = {},
) {
  return {
    number,
    title: `Issue ${number}`,
    body: `body ${number}`,
    url: `https://github.com/o/r/issues/${number}`,
    labels: labels.map((name) => ({ name })),
    blockedBy: { totalCount: blockedBy.length, nodes: blockedBy },
    ...extra,
  };
}

const LIST = "issue list";
const REFS = "api repos/o/r/git/matching-refs/heads/afk/";

function backlog(routes: Record<string, string | Error>) {
  const { gh, calls } = fakeGh(routes);
  return { calls, backlog: createGithubBacklog({ repo: "o/r", label: "afk", gh }) };
}

test("lists open issues with the AFK label and no open blocker", async () => {
  const { backlog: b } = backlog({
    [LIST]: JSON.stringify([issue(1, ["afk"]), issue(2, ["afk"], [{ state: "OPEN" }]), issue(3, ["afk"], [{ state: "CLOSED" }])]),
    [REFS]: "",
  });
  const ready = await b.listReady();
  assert.deepEqual(ready.map((i) => i.id), ["1", "3"]);
  assert.equal(ready[0].title, "Issue 1");
  assert.equal(ready[0].url, "https://github.com/o/r/issues/1");
});

test("asks gh for open issues carrying the configured label", async () => {
  const { gh, calls } = fakeGh({ [LIST]: "[]", [REFS]: "" });
  await createGithubBacklog({ repo: "o/r", label: "go", gh }).listReady();
  const list = calls[0].args;
  assert.ok(list.includes("--label") && list[list.indexOf("--label") + 1] === "go");
  assert.ok(list.includes("--repo") && list[list.indexOf("--repo") + 1] === "o/r");
  assert.equal(list[list.indexOf("--state") + 1], "open");
});

test("an issue with an afk/<id> branch on the remote is claimed and not ready", async () => {
  const { backlog: b } = backlog({
    [LIST]: JSON.stringify([issue(1, ["afk"]), issue(2, ["afk"])]),
    [REFS]: "refs/heads/afk/2\nrefs/heads/afk/9\n",
  });
  assert.deepEqual((await b.listReady()).map((i) => i.id), ["1"]);
});

test("a blocker in another repository counts while open", async () => {
  const { backlog: b } = backlog({
    [LIST]: JSON.stringify([issue(1, ["afk"], [{ state: "OPEN", url: "https://github.com/x/y/issues/4" }])]),
    [REFS]: "",
  });
  assert.deepEqual(await b.listReady(), []);
});

test("an unreadable blocker (unknown state) counts as open", async () => {
  const { backlog: b } = backlog({
    [LIST]: JSON.stringify([issue(1, ["afk"], [{ state: "" }]), issue(2, ["afk"], [{} as never])]),
    [REFS]: "",
  });
  assert.deepEqual(await b.listReady(), []);
});

test("more blockers than gh returned counts as blocked", async () => {
  const i = issue(1, ["afk"], [{ state: "CLOSED" }]);
  i.blockedBy.totalCount = 3;
  const { backlog: b } = backlog({ [LIST]: JSON.stringify([i]), [REFS]: "" });
  assert.deepEqual(await b.listReady(), []);
});

test("an afk:<agent> label overrides the implementer", async () => {
  const { backlog: b } = backlog({
    [LIST]: JSON.stringify([issue(1, ["afk", "afk:codex"]), issue(2, ["afk"])]),
    [REFS]: "",
  });
  const ready = await b.listReady();
  assert.equal(ready[0].agent, "codex");
  assert.equal(ready[1].agent, undefined);
});

test("an unknown or conflicting agent override makes the issue not ready", async () => {
  const { backlog: b } = backlog({
    [LIST]: JSON.stringify([issue(1, ["afk", "afk:gpt"]), issue(2, ["afk", "afk:codex", "afk:cursor"]), issue(3, ["afk", "afk:claude"])]),
    [REFS]: "",
  });
  assert.deepEqual((await b.listReady()).map((i) => i.id), ["3"]);
});

test("the override prefix follows the configured label", async () => {
  const { gh } = fakeGh({
    [LIST]: JSON.stringify([issue(1, ["go", "go:cursor"])]),
    [REFS]: "",
  });
  const ready = await createGithubBacklog({ repo: "o/r", label: "go", gh }).listReady();
  assert.equal(ready[0].agent, "cursor");
});

test("fails closed when gh fails, prints junk, or the claim lookup fails", async () => {
  for (const routes of [
    { [LIST]: new Error("rate limit exceeded"), [REFS]: "" },
    { [LIST]: "not json", [REFS]: "" },
    { [LIST]: '{"not":"an array"}', [REFS]: "" },
    { [LIST]: JSON.stringify([{ number: 1 }]), [REFS]: "" },
    { [LIST]: JSON.stringify([issue(1, ["afk"])]), [REFS]: new Error("HTTP 502") },
  ]) {
    await assert.rejects(backlog(routes).backlog.listReady());
  }
});

test("markReadyForHuman creates the labels, swaps afk for ready-for-human, and comments", async () => {
  const { backlog: b, calls } = backlog({});
  await b.markReadyForHuman("7", "Branch afk/7 pushed.");
  const lines = calls.map((c) => c.args.join(" "));
  assert.ok(lines.some((l) => l.startsWith("label create ready-for-human") && l.includes("--repo o/r")));
  const edit = lines.find((l) => l.startsWith("issue edit 7"))!;
  assert.match(edit, /--add-label ready-for-human/);
  assert.match(edit, /--remove-label afk(\s|$)/);
  const comment = calls.find((c) => c.args[0] === "issue" && c.args[1] === "comment")!;
  assert.equal(comment.input, "Branch afk/7 pushed.");
});

test("markBlocked swaps afk for afk-blocked and comments the reason", async () => {
  const { backlog: b, calls } = backlog({});
  await b.markBlocked("7", "Nothing was pushed: tests never went green.");
  const lines = calls.map((c) => c.args.join(" "));
  assert.ok(lines.some((l) => l.startsWith("label create afk-blocked")));
  assert.match(lines.find((l) => l.startsWith("issue edit 7"))!, /--add-label afk-blocked.*--remove-label afk(\s|$)/);
  assert.equal(calls.find((c) => c.args[1] === "comment")!.input, "Nothing was pushed: tests never went green.");
});

test("label swaps are idempotent: an already existing label is not an error", async () => {
  const { backlog: b } = backlog({ "label create": new Error("label with name \"afk-blocked\" already exists") });
  await b.markBlocked("7", "why");
  await b.markBlocked("7", "why");
});

test("other label-creation failures propagate", async () => {
  const { backlog: b } = backlog({ "label create": new Error("HTTP 403") });
  await assert.rejects(b.markBlocked("7", "why"));
});

test("comment posts the body through stdin, never as an argument", async () => {
  const { backlog: b, calls } = backlog({});
  await b.comment("7", "Spec findings: `rm -rf` \"quoted\"");
  assert.deepEqual(calls[0].args, ["issue", "comment", "7", "--repo", "o/r", "--body-file", "-"]);
  assert.equal(calls[0].input, "Spec findings: `rm -rf` \"quoted\"");
});

test("rejects ids that are not issue numbers", async () => {
  const { backlog: b } = backlog({});
  await assert.rejects(b.comment("--repo x", "hi"));
  await assert.rejects(b.markBlocked("7; rm", "hi"));
});

test("spawnGh rejects instead of crashing when the process exits before reading its input", async () => {
  const big = "x".repeat(8 * 1024 * 1024);
  await assert.rejects(spawnGh(process.execPath, ["-e", "process.exit(3)"], big), /exited 3|EPIPE|write/);
});

test("spawnGh decodes multi-byte characters split across chunks", async () => {
  const script =
    "const b=Buffer.from('a\u20ac b');process.stdout.write(b.subarray(0,2));" +
    "setTimeout(()=>process.stdout.write(b.subarray(2)),50)";
  assert.equal(await spawnGh(process.execPath, ["-e", script]), "a€ b");
});

test("an invalid or conflicting agent override is reported by listRejected, not ready", async () => {
  const { backlog: b } = backlog({
    [LIST]: JSON.stringify([issue(1, ["afk", "afk:gpt"]), issue(2, ["afk", "afk:codex", "afk:cursor"]), issue(3, ["afk"])]),
    [REFS]: "",
  });
  assert.deepEqual((await b.listReady()).map((i) => i.id), ["3"]);
  const rejected = await b.listRejected();
  assert.deepEqual(rejected.map((r) => r.id), ["1", "2"]);
  assert.ok(rejected.every((r) => r.reason.length > 0));
});

test("listRejected leaves blocked and claimed issues out and has no side effects", async () => {
  const { backlog: b, calls } = backlog({
    [LIST]: JSON.stringify([issue(1, ["afk", "afk:gpt"], [{ state: "OPEN" }]), issue(2, ["afk", "afk:gpt"])]),
    [REFS]: "refs/heads/afk/2\n",
  });
  assert.deepEqual(await b.listRejected(), []);
  assert.ok(calls.every((c) => c.args[0] === "issue" && c.args[1] === "list" || c.args[0] === "api"));
});

test("the swap methods accept an optional context and the GitHub backlog ignores it", async () => {
  const { backlog: b, calls } = backlog({});
  await b.markBlocked("7", "why", { workdir: "/somewhere" });
  await b.markReadyForHuman("7", "done", { workdir: "/somewhere" });
  assert.ok(calls.every((c) => !c.args.includes("/somewhere")));
});
