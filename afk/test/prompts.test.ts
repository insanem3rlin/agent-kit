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

test("the issue text sits in a delimited block that is declared untrusted data", () => {
  for (const phase of ["implement", "review"] as const) {
    const text = loadPrompt(phase, "/nonexistent", read);
    const block = /<untrusted-issue>\n([\s\S]*?)\n<\/untrusted-issue>/.exec(text);
    assert.ok(block, `${phase}: no delimited block`);
    assert.match(block[1], /\{\{ISSUE_TITLE\}\}/);
    assert.match(block[1], /\{\{ISSUE_BODY\}\}/);
    const outside = text.replace(block[0], "");
    assert.ok(!/\{\{ISSUE_(TITLE|BODY)\}\}/.test(outside), `${phase}: issue text outside the block`);
    assert.match(text, /untrusted data/i);
    assert.match(text, /secrets/i);
  }
});
