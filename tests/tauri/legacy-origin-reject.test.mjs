import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

function forbiddenNeedles() {
  return [
    ["CONTROL_API", "_ORIGIN"].join(""),
    ["control_api", "_token"].join(""),
    ["175.27.", "132.61"].join(""),
  ];
}

function trackedFiles() {
  return execFileSync("git", ["ls-files"], { encoding: "utf8" })
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
}

test("tracked files do not contain author origin or login cookie names", () => {
  const needles = forbiddenNeedles();
  const hits = [];

  for (const file of trackedFiles()) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const needle of needles) {
      if (text.includes(needle)) {
        hits.push(`${file}: ${needle}`);
      }
    }
  }

  assert.deepEqual(hits, []);
});
