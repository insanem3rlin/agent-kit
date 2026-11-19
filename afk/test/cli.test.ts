import assert from "node:assert/strict";
import { test } from "node:test";
import { run, USAGE } from "../src/cli.ts";

function capture(argv: string[]): { code: number; out: string } {
  let out = "";
  const code = run(argv, (t) => (out += t));
  return { code, out };
}

test("--help prints the usage and succeeds", () => {
  assert.deepEqual(capture(["--help"]), { code: 0, out: USAGE });
  assert.equal(capture(["-h"]).code, 0);
});

test("without a daemon yet, a plain run fails loudly", () => {
  const r = capture([]);
  assert.equal(r.code, 1);
  assert.match(r.out, /not implemented/);
});
