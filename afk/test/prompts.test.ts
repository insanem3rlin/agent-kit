import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { loadPrompt, renderPrompt } from "../src/prompts.ts";

const read = (p: string) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
};

test("the default prompts use only placeholders the run fills in", () => {
  const known = ["ISSUE_ID", "ISSUE_TITLE", "ISSUE_URL", "ISSUE_BODY", "BRANCH", "BASE_BRANCH", "FINDINGS_FILE"];
  for (const phase of ["implement", "review"] as const) {
    const text = loadPrompt(phase, "/nonexistent", read);
    for (const m of text.matchAll(/\{\{([A-Z_]+)\}\}/g)) assert.ok(known.includes(m[1]), `${phase}: ${m[1]}`);
    assert.match(text, /never push/i);
    assert.match(text, /\.github\/workflows/);
    assert.match(text, /## Verify/);
  }
  assert.match(loadPrompt("review", "/nonexistent", read), /\{\{FINDINGS_FILE\}\}/);
});

test("a value is never expanded a second time", () => {
  assert.equal(renderPrompt("{{A}} {{B}} {{C}}", { A: "{{B}}", B: "x" }), "{{B}} x {{C}}");
});
