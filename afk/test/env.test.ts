import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { afkEnvPath, EnvError, loadAfkEnv, parseEnv, requireSecrets } from "../src/env.ts";

test("parseEnv reads KEY=VALUE, comments, blank lines, export and quotes", () => {
  const text = [
    "# tokens",
    "",
    "GH_TOKEN=abc",
    "export OPENAI_API_KEY = def ",
    'CURSOR_API_KEY="with space"',
    "ANTHROPIC_API_KEY='single'",
    "EMPTY=",
    "AFK_NOTIFY_URL=https://example.invalid/hook?a=b=c",
  ].join("\n");
  assert.deepEqual(parseEnv(text), {
    GH_TOKEN: "abc",
    OPENAI_API_KEY: "def",
    CURSOR_API_KEY: "with space",
    ANTHROPIC_API_KEY: "single",
    EMPTY: "",
    AFK_NOTIFY_URL: "https://example.invalid/hook?a=b=c",
  });
});

test("parseEnv rejects a line that is not KEY=VALUE, naming the line number", () => {
  assert.throws(
    () => parseEnv("GH_TOKEN=a\nnonsense"),
    (e: unknown) => {
      assert.ok(e instanceof EnvError);
      assert.match(e.message, /line 2/);
      return true;
    },
  );
});

test("afkEnvPath honours AGENT_KIT_CONFIG, else ~/.config/agent-kit", () => {
  assert.equal(afkEnvPath({ AGENT_KIT_CONFIG: "/x" }, "/home/u"), join("/x", "afk.env"));
  assert.equal(afkEnvPath({}, "/home/u"), join("/home/u", ".config", "agent-kit", "afk.env"));
});

test("loadAfkEnv fails closed on a missing file, naming the path", () => {
  const path = join(mkdtempSync(join(tmpdir(), "afk-env-")), "afk.env");
  assert.throws(
    () => loadAfkEnv(path),
    (e: unknown) => {
      assert.ok(e instanceof EnvError);
      assert.ok(e.message.includes(path));
      assert.match(e.message, /GH_TOKEN/);
      return true;
    },
  );
});

test("loadAfkEnv returns the parsed file", () => {
  const path = join(mkdtempSync(join(tmpdir(), "afk-env-")), "afk.env");
  writeFileSync(path, "GH_TOKEN=t\n");
  assert.deepEqual(loadAfkEnv(path), { GH_TOKEN: "t" });
});

test("requireSecrets needs GH_TOKEN and a token for every agent in use", () => {
  const missing = (env: Record<string, string>) => {
    try {
      requireSecrets(env, ["claude", "codex"]);
      return "";
    } catch (e) {
      return (e as Error).message;
    }
  };
  assert.match(missing({}), /GH_TOKEN/);
  assert.match(missing({ GH_TOKEN: "t" }), /CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY/);
  assert.match(missing({ GH_TOKEN: "t", ANTHROPIC_API_KEY: "k" }), /OPENAI_API_KEY/);
  assert.equal(missing({ GH_TOKEN: "t", CLAUDE_CODE_OAUTH_TOKEN: "k", OPENAI_API_KEY: "o" }), "");
  assert.match(missing({ GH_TOKEN: "", ANTHROPIC_API_KEY: "k", OPENAI_API_KEY: "o" }), /GH_TOKEN/);
});
