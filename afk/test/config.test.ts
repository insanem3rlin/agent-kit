import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigError, loadConfig, parseConfig } from "../src/config.ts";

const valid = {
  backlog: "github",
  label: "afk",
  baseBranch: "main",
  implementer: "claude",
  reviewer: "codex",
  concurrency: 2,
};

function rejects(raw: unknown, field: string, problem: RegExp) {
  assert.throws(
    () => parseConfig(raw),
    (e: unknown) => {
      assert.ok(e instanceof ConfigError);
      assert.equal(e.field, field);
      assert.match(e.message, new RegExp(`^${field}: `));
      assert.match(e.message, problem);
      return true;
    },
  );
}

test("a complete config parses to the typed value", () => {
  assert.deepEqual(parseConfig(valid), valid);
});

test("backlog accepts github and backlog-md only", () => {
  assert.equal(parseConfig({ ...valid, backlog: "backlog-md" }).backlog, "backlog-md");
  rejects({ ...valid, backlog: "jira" }, "backlog", /github.*backlog-md/);
});

test("an unknown agent is an error, for implementer and reviewer", () => {
  rejects({ ...valid, implementer: "gemini" }, "implementer", /claude.*codex.*cursor/);
  rejects({ ...valid, reviewer: "" }, "reviewer", /claude.*codex.*cursor/);
});

test("concurrency must be an integer of at least 1", () => {
  rejects({ ...valid, concurrency: 0 }, "concurrency", /at least 1/);
  rejects({ ...valid, concurrency: -3 }, "concurrency", /at least 1/);
  rejects({ ...valid, concurrency: 1.5 }, "concurrency", /integer/);
  rejects({ ...valid, concurrency: "2" }, "concurrency", /integer/);
});

test("label and baseBranch must be non-empty strings", () => {
  rejects({ ...valid, label: "  " }, "label", /non-empty/);
  rejects({ ...valid, baseBranch: 7 }, "baseBranch", /non-empty/);
});

test("a missing field is an error naming it (no silent defaults)", () => {
  for (const key of Object.keys(valid)) {
    const rest: Record<string, unknown> = { ...valid };
    delete rest[key];
    rejects(rest, key, /required/);
  }
});

test("an unknown key is an error naming it", () => {
  rejects({ ...valid, concurency: 3 }, "concurency", /unknown/);
});

test("a non-object config is an error", () => {
  rejects([], "config", /object/);
  rejects(null, "config", /object/);
});

function repoWith(config?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "afk-config-"));
  if (config !== undefined) {
    mkdirSync(join(dir, ".afk"));
    writeFileSync(join(dir, ".afk", "config.json"), config);
  }
  return dir;
}

test("loadConfig reads .afk/config.json of a repository", () => {
  assert.deepEqual(loadConfig(repoWith(JSON.stringify(valid))), valid);
});

test("loadConfig points at `afk init` when the file is missing", () => {
  assert.throws(() => loadConfig(repoWith()), /config\.json.*agent-kit afk init/s);
});

test("loadConfig names the file when the JSON is broken", () => {
  assert.throws(() => loadConfig(repoWith("{nope")), /config\.json.*not valid JSON/s);
});
