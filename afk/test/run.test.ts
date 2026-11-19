import assert from "node:assert/strict";
import { test } from "node:test";
import type { AfkConfig } from "../src/config.ts";
import { EnvError } from "../src/env.ts";
import { runIssue } from "../src/run.ts";
import type { AgentRun, RunPorts, RunSandbox } from "../src/run.ts";
import type { Backlog, BacklogIssue } from "../src/backlog/types.ts";

const issue: BacklogIssue = { id: "7", title: "Add the thing", body: "Do {{X}} the thing", url: "https://example.test/7" };
const config: AfkConfig = { backlog: "github", label: "afk", baseBranch: "main", implementer: "claude", reviewer: "claude", concurrency: 1 };
const env = { GH_TOKEN: "gh-token", ANTHROPIC_API_KEY: "a-key", OPENAI_API_KEY: "o-key", CURSOR_API_KEY: "c-key" }; // leak-check: allow

interface Setup {
  log: string[];
  agentRuns: AgentRun[];
  opened: { branch: string; baseRef: string; env: Record<string, string> }[];
  prs: { repoDir: string; head: string; base: string; title: string; body: string }[];
  prComments: string[];
  backlogCalls: { fn: string; id: string; text: string; workdir?: string }[];
  ports: RunPorts;
  backlog: Backlog;
}

function setup(o: {
  files?: Record<string, string>;
  commits?: number;
  changed?: string[];
  findings?: string | null;
  failAgent?: (r: AgentRun) => Error | undefined;
  failPush?: boolean;
} = {}): Setup {
  const s = { log: [], agentRuns: [], opened: [], prs: [], prComments: [], backlogCalls: [] } as unknown as Setup;
  const sandbox: RunSandbox = {
    workdir: "/work/afk-7",
    async runAgent(r) {
      s.log.push(`agent:${r.agent}:${r.model}`);
      s.agentRuns.push(r);
      const err = o.failAgent?.(r);
      if (err) throw err;
    },
    async readFile(path) {
      s.log.push(`read:${path}`);
      return o.findings ?? null;
    },
    async close() {
      s.log.push("close");
    },
  };
  s.ports = {
    async openSandbox(opts) {
      s.log.push("open");
      s.opened.push(opts);
      return sandbox;
    },
    git: {
      async commitCount() {
        return o.commits ?? 2;
      },
      async changedFiles() {
        return o.changed ?? ["src/a.ts"];
      },
      async resetTo(_w, ref) {
        s.log.push(`reset:${ref}`);
      },
      async push(_w, branch) {
        s.log.push(`push:${branch}`);
        if (o.failPush) throw new Error("rejected");
      },
    },
    github: {
      async createDraftPr(a) {
        s.log.push("pr");
        s.prs.push(a);
        return "https://github.test/o/r/pull/9";
      },
      async commentOnPr(_r, url, body) {
        s.log.push(`prcomment:${url}`);
        s.prComments.push(body);
      },
    },
    readText: (p) => o.files?.[p.replaceAll("\\", "/")] ?? (p.endsWith("implement.md") || p.endsWith("review.md") ? `DEFAULT ${p.split(/[\\/]/).pop()} {{ISSUE_BODY}} {{FINDINGS_FILE}}` : null),
  };
  const rec = (fn: string) => async (id: string, text: string, ctx?: { workdir?: string }) => {
    s.log.push(`backlog:${fn}`);
    s.backlogCalls.push({ fn, id, text, workdir: ctx?.workdir });
  };
  s.backlog = {
    listReady: async () => [],
    listRejected: async () => [],
    markReadyForHuman: rec("ready"),
    markBlocked: rec("blocked"),
    comment: async (id, body) => {
      s.log.push("backlog:comment");
      s.backlogCalls.push({ fn: "comment", id, text: body });
    },
  };
  return s;
}

const input = (s: Setup, over: Partial<Parameters<typeof runIssue>[0]> = {}) => ({
  issue, config, env, repoDir: "/repo", github: true, backlog: s.backlog, ports: s.ports, ...over,
});

test("a ready run: implementer then reviewer in one sandbox, push, draft PR, then ready-for-human", async () => {
  const s = setup();
  const out = await runIssue(input(s));
  assert.deepEqual(out, { status: "ready", branch: "afk/7", prUrl: "https://github.test/o/r/pull/9" });
  assert.deepEqual(s.log.filter((l) => !l.startsWith("read:")), [
    "open", "agent:claude:sonnet", "agent:claude:opus", "push:afk/7", "pr", "backlog:ready", "close",
  ]);
  assert.equal(s.opened.length, 1);
  assert.equal(s.opened[0].branch, "afk/7");
  assert.equal(s.opened[0].baseRef, "origin/main");
  assert.deepEqual(s.prs, [{ repoDir: "/repo", head: "afk/7", base: "main", title: "Add the thing", body: s.prs[0].body }]);
  assert.match(s.prs[0].body, /Closes #7/);
  assert.equal(s.backlogCalls[0].workdir, "/work/afk-7");
  assert.match(s.backlogCalls[0].text, /pull\/9/);
});

test("an agent override label replaces the implementer only", async () => {
  const s = setup();
  await runIssue(input(s, { issue: { ...issue, agent: "codex" } }));
  assert.deepEqual(s.agentRuns.map((r) => [r.agent, r.model]), [["codex", "gpt-6.1-terra"], ["claude", "opus"]]);
});

test("implementer and reviewer are chosen separately, with models from the role table", async () => {
  const s = setup();
  await runIssue(input(s, { config: { ...config, implementer: "cursor", reviewer: "codex" } }));
  assert.deepEqual(s.agentRuns.map((r) => [r.agent, r.model]), [["cursor", "grok-4.7-high-fast"], ["codex", "gpt-6.1-sol"]]);
});

test("the sandbox gets only the tokens of the agents in use, never GH_TOKEN", async () => {
  const s = setup();
  await runIssue(input(s));
  assert.deepEqual(s.opened[0].env, { ANTHROPIC_API_KEY: "a-key" }); // leak-check: allow
  const s2 = setup();
  await runIssue(input(s2, { config: { ...config, implementer: "codex" } }));
  assert.deepEqual(s2.opened[0].env, { ANTHROPIC_API_KEY: "a-key", OPENAI_API_KEY: "o-key" }); // leak-check: allow
});

test("a missing token throws before anything starts", async () => {
  const s = setup();
  await assert.rejects(runIssue(input(s, { env: { GH_TOKEN: "x" } })), EnvError);
  assert.deepEqual(s.log, []);
});

test("default prompts are used and filled with the issue; a repo override wins", async () => {
  const s = setup();
  await runIssue(input(s));
  assert.match(s.agentRuns[0].prompt, /^DEFAULT implement\.md Do \{\{X\}\} the thing /);
  assert.match(s.agentRuns[1].prompt, /^DEFAULT review\.md /);
  // the findings file the reviewer is told about is the one the run reads
  const findingsPath = /(\/\S+)$/.exec(s.agentRuns[1].prompt)![1];
  assert.ok(s.log.includes(`read:${findingsPath}`));

  const o = setup({ files: { "/repo/.afk/review.md": "MINE {{ISSUE_ID}} on {{BRANCH}} vs {{BASE_BRANCH}}" } });
  await runIssue(input(o));
  assert.match(o.agentRuns[0].prompt, /^DEFAULT implement\.md/);
  assert.equal(o.agentRuns[1].prompt, "MINE 7 on afk/7 vs main");
});

test("no commits: blocked, nothing pushed, nothing opened as a PR", async () => {
  const s = setup({ commits: 0 });
  const out = await runIssue(input(s));
  assert.equal(out.status, "blocked");
  assert.ok(!s.log.some((l) => l.startsWith("push") || l === "pr"));
  assert.deepEqual(s.backlogCalls.map((c) => c.fn), ["blocked"]);
  assert.match(s.backlogCalls[0].text, /no commits/i);
  assert.equal(s.log.at(-1), "close");
});

test("a change under .github/workflows is refused before pushing", async () => {
  const s = setup({ changed: ["src/a.ts", ".github/workflows/ci.yml"] });
  const out = await runIssue(input(s));
  assert.equal(out.status, "blocked");
  assert.ok(!s.log.some((l) => l.startsWith("push") || l === "pr"));
  assert.match(s.backlogCalls[0].text, /\.github\/workflows\/ci\.yml/);
  assert.ok(s.log.includes("reset:origin/main"));
});

test("a branch that would be the base branch is refused before a sandbox opens", async () => {
  const s = setup();
  const out = await runIssue(input(s, { config: { ...config, baseBranch: "afk/7" } }));
  assert.equal(out.status, "blocked");
  assert.ok(!s.log.includes("open"));
  assert.match(s.backlogCalls[0].text, /base branch/i);
});

test("an implementer failure blocks the issue and pushes nothing", async () => {
  const s = setup({ failAgent: (r) => (r.model === "sonnet" ? new Error("boom") : undefined) });
  const out = await runIssue(input(s));
  assert.equal(out.status, "blocked");
  assert.ok(!s.agentRuns.some((r) => r.model === "opus"));
  assert.ok(!s.log.some((l) => l.startsWith("push")));
  assert.match(s.backlogCalls[0].text, /boom/);
  assert.equal(s.log.at(-1), "close");
});

test("a reviewer failure keeps the implementer's work and says so in the PR", async () => {
  const s = setup({ failAgent: (r) => (r.model === "opus" ? new Error("review crashed") : undefined) });
  const out = await runIssue(input(s));
  assert.equal(out.status, "ready");
  assert.match(s.prs[0].body, /review did not complete.*review crashed/i);
});

test("a failed push blocks and still closes the sandbox", async () => {
  const s = setup({ failPush: true });
  const out = await runIssue(input(s));
  assert.equal(out.status, "blocked");
  assert.match(s.backlogCalls[0].text, /rejected/);
  assert.ok(!s.log.includes("pr"));
  assert.equal(s.log.at(-1), "close");
});

test("Spec findings are posted as a PR comment on GitHub", async () => {
  const s = setup({ findings: "The issue asked for X; X is missing." });
  await runIssue(input(s));
  assert.deepEqual(s.prComments, ["The issue asked for X; X is missing."]);
  assert.ok(s.log.indexOf("pr") < s.log.indexOf("prcomment:https://github.test/o/r/pull/9"));
  assert.ok(!s.backlogCalls.some((c) => c.fn === "comment"));
});

test("without a GitHub remote there is no PR and Spec findings go to the issue", async () => {
  const s = setup({ findings: "missing X" });
  const out = await runIssue(input(s, { github: false, config: { ...config, backlog: "backlog-md" }, env: { ANTHROPIC_API_KEY: "a-key" } })); // leak-check: allow
  assert.deepEqual(out, { status: "ready", branch: "afk/7" });
  assert.ok(!s.log.includes("pr"));
  assert.deepEqual(s.backlogCalls.filter((c) => c.fn === "comment").map((c) => c.text), ["missing X"]);
});

test("blank findings post nothing", async () => {
  const s = setup({ findings: "  \n" });
  await runIssue(input(s));
  assert.deepEqual(s.prComments, []);
});

test("Backlog.md: the label swap is committed in the workdir and pushed after it", async () => {
  const s = setup();
  const cfg = { ...config, backlog: "backlog-md" as const };
  await runIssue(input(s, { config: cfg }));
  assert.ok(!/Closes/.test(s.prs[0].body));
  assert.deepEqual(s.log.filter((l) => /^(push|pr|backlog:ready)/.test(l)), ["push:afk/7", "pr", "backlog:ready", "push:afk/7"]);
});

test("Backlog.md blocked: the branch is reset to the base, the swap committed, and only that pushed", async () => {
  const s = setup({ commits: 0 });
  await runIssue(input(s, { config: { ...config, backlog: "backlog-md" } }));
  assert.deepEqual(s.log.filter((l) => /^(reset|push|backlog)/.test(l)), ["reset:origin/main", "backlog:blocked", "push:afk/7"]);
  assert.equal(s.backlogCalls[0].workdir, "/work/afk-7");
});

test("GitHub blocked pushes nothing", async () => {
  const s = setup({ commits: 0 });
  await runIssue(input(s));
  assert.ok(!s.log.some((l) => l.startsWith("push")));
});
