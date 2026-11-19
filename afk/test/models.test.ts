import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { MODELS, modelFor } from "../src/models.ts";

const adapters = new URL("../../adapters/", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, adapters), "utf8");

test("the model table matches the models pinned in the adapters", () => {
  const toml = (role: string) => /^model\s*=\s*"([^"]+)"/m.exec(read(`codex/agents/${role}.toml`))![1];
  const md = (dir: string, role: string) => /^model:\s*(\S+)/m.exec(read(`${dir}/agents/${role}.md`))![1];
  for (const role of ["implementer", "reviewer"] as const) {
    assert.equal(MODELS.codex[role], toml(role));
    assert.equal(MODELS.cursor[role], md("cursor", role));
    assert.equal(MODELS.claude[role], md("claude-code", role));
    assert.equal(modelFor("codex", role), toml(role));
  }
});
