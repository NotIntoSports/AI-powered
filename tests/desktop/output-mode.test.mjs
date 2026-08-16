import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_OUTPUT_MODE, parseOutputMode } from "../../features/readiness/output-mode.ts";

test("output mode defaults to real camera and only accepts virtual explicitly", () => {
  assert.equal(DEFAULT_OUTPUT_MODE, "real");
  assert.equal(parseOutputMode(null), "real");
  assert.equal(parseOutputMode(""), "real");
  assert.equal(parseOutputMode("real"), "real");
  assert.equal(parseOutputMode("virtual"), "virtual");
  assert.equal(parseOutputMode("obs"), "real");
});
