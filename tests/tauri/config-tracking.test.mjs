import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

function trackedUnder(...paths) {
  return execFileSync("git", ["ls-files", ...paths], { encoding: "utf8" })
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((file) => file.replaceAll("\\", "/"));
}

test("Git never tracks local configuration or recovery files", () => {
  const forbidden = trackedUnder("config").filter((file) =>
    /(^|\/)local\.json$|\.local\.json$|\.backup\.json$|\.tmp$/i.test(file),
  );
  assert.deepEqual(forbidden, []);
});

test("Git never tracks local-only docs or agent ledgers", () => {
  assert.deepEqual(trackedUnder(".superpowers", "docs"), []);
});
