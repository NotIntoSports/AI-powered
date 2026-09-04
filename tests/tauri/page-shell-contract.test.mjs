import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, extname } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

/**
 * Recursively collect all .ts/.tsx files from a directory.
 */
async function collectSourceFiles(dir) {
  const results = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await collectSourceFiles(fullPath));
    } else if ([".ts", ".tsx"].includes(extname(entry.name)) && !entry.name.includes(".test.")) {
      results.push(fullPath);
    }
  }
  return results;
}

// Collect all shell source files (non-test .ts/.tsx in screens/, components/, and shell.tsx)
const shellFiles = [
  ...await collectSourceFiles("src/screens"),
  ...await collectSourceFiles("src/components"),
  "src/app/shell.tsx",
];

test("page shell does not directly import Tauri API", async () => {
  for (const file of shellFiles) {
    const content = await readFile(file, "utf8");
    assert.doesNotMatch(content, /@tauri-apps\/api/, `${file} must not import @tauri-apps/api`);
  }
});

test("page shell does not call fetch", async () => {
  for (const file of shellFiles) {
    const content = await readFile(file, "utf8");
    assert.doesNotMatch(content, /\bfetch\s*\(/, `${file} must not call fetch()`);
  }
});

test("page shell does not reference old API routes", async () => {
  for (const file of shellFiles) {
    const content = await readFile(file, "utf8");
    assert.doesNotMatch(content, /["'`]\/api\//, `${file} must not reference /api/ paths`);
  }
});

test("page shell does not import Next.js modules", async () => {
  for (const file of shellFiles) {
    const content = await readFile(file, "utf8");
    assert.doesNotMatch(content, /next\/(link|navigation|router|head)/, `${file} must not import next/*`);
  }
});

test("page shell does not use target=_blank", async () => {
  for (const file of shellFiles) {
    const content = await readFile(file, "utf8");
    assert.doesNotMatch(content, /target=["']_blank["']/, `${file} must not use target="_blank"`);
  }
});

test("page shell does not contain login/logout concepts", async () => {
  for (const file of shellFiles) {
    const content = await readFile(file, "utf8");
    assert.doesNotMatch(content, /登录|退出登录|control[-_]session/i, `${file} must not contain login concepts`);
  }
});

test("page shell does not use polling patterns", async () => {
  for (const file of shellFiles) {
    const content = await readFile(file, "utf8");
    assert.doesNotMatch(content, /setInterval/, `${file} must not use setInterval`);
    assert.doesNotMatch(content, /setTimeout\s*\([^)]*\d{3,}/, `${file} must not use long setTimeout`);
  }
});

test("security surface has zero drift since Phase 0-1 acceptance", () => {
  // These files must be IDENTICAL to commit 1bc6bfb (Phase 0-1 acceptance)
  const pinnedFiles = [
    "src-tauri/capabilities/main.json",
    "src-tauri/src/lib.rs",
    "src-tauri/src/contracts.rs",
    "src-tauri/src/commands.rs",
    "src-tauri/tauri.conf.json",
    "src/api/commands.ts",
    "src/generated/bindings.ts",
    "tests/tauri/shell-contract.test.mjs",
    "src-tauri/tests/security_contract.rs",
  ];
  // git diff --exit-code returns 0 if no differences, 1 if differences exist
  const result = execFileSync(
    "git",
    ["diff", "--exit-code", "1bc6bfb", "--", ...pinnedFiles],
    { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
  );
  // If we get here without throwing, exit code was 0 = no drift
  assert.equal(result, "");
});

test("route ids match the design spec", async () => {
  const routesContent = await readFile("src/app/routes.ts", "utf8");
  // Extract the routeIds array
  const match = routesContent.match(/routeIds\s*=\s*\[([^\]]+)\]/);
  assert.ok(match, "routeIds array must exist in routes.ts");
  const ids = match[1].split(",").map(s => s.trim().replace(/["']/g, ""));
  assert.deepEqual(ids, ["workspace", "materials", "records", "services", "settings"]);
});

test("app.tsx retains startup dispatch structure", async () => {
  const appContent = await readFile("src/app/app.tsx", "utf8");
  assert.match(appContent, /getStartupState/, "app.tsx must call getStartupState");
  assert.match(appContent, /ConfigRepair/, "app.tsx must render ConfigRepair");
  assert.match(appContent, /Shell/, "app.tsx must render Shell");
});
