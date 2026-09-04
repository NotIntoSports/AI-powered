import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

test("Git never tracks local configuration or recovery files", () => {
  const tracked = execFileSync("git", ["ls-files", "config"], { encoding: "utf8" })
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((file) => file.replaceAll("\\", "/"));

  const forbidden = tracked.filter((file) =>
    /(^|\/)local\.json$|\.local\.json$|\.backup\.json$|\.tmp$/i.test(file),
  );
  assert.deepEqual(forbidden, []);
});
