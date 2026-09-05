import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("parallel Tauri shell preserves legacy entry points", async () => {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  const vite = await readFile("vite.config.ts", "utf8");
  const tauri = JSON.parse(await readFile("src-tauri/tauri.conf.json", "utf8"));

  assert.match(vite, /outDir:\s*["']dist-tauri-ui["']/);
  assert.match(vite, /host:\s*["']127\.0\.0\.1["']/);
  assert.match(vite, /port:\s*1420/);
  assert.deepEqual(vite.match(/envPrefix:\s*\[[^\]]+\]/)?.[0], 'envPrefix: ["TAURI_ENV_"]');
  assert.equal(tauri.build.frontendDist, "../dist-tauri-ui");
  assert.equal(tauri.build.devUrl, "http://127.0.0.1:1420");
  assert.equal(tauri.identifier, "com.aivirtualassistant.desktop");
  const capability = JSON.parse(await readFile("src-tauri/capabilities/main.json", "utf8"));
  // (5) window scope pinned to exactly ["main"].
  assert.deepEqual(capability.windows, ["main"]);
  const permissions = capability.permissions;
  assert.ok(Array.isArray(permissions), "capability.permissions must be an array");
  // Phase 0-1 accepted baseline. Phase 3+ may ADD command permissions but must
  // never lose these, so we assert a superset (containment) rather than equality.
  const baselinePermissions = [
    "core:default",
    "allow-foundation-get-status",
    "allow-diagnostics-export",
    "allow-config-get-startup-state",
    "allow-config-restore-last-good",
    "allow-config-restore-defaults",
    "allow-open-app-directory",
  ];
  // (1) always includes core:default.
  assert.ok(permissions.includes("core:default"), "capability must include core:default");
  // (3) superset of the Phase 0-1 baseline.
  for (const required of baselinePermissions) {
    assert.ok(
      permissions.includes(required),
      `capability must retain baseline permission: ${required}`,
    );
  }
  // (2) every entry matches the explicit allow-list shape.
  const shape = /^(core:default|allow-[a-z0-9-]+)$/;
  for (const permission of permissions) {
    assert.match(permission, shape, `unexpected capability permission shape: ${permission}`);
  }
  // (4) no duplicate grants.
  assert.equal(
    new Set(permissions).size,
    permissions.length,
    "capability.permissions must not contain duplicates",
  );
  assert.doesNotMatch(JSON.stringify(capability), /shell:allow-(?:execute|spawn)|fs:|https?:\/\/|"\*"/i);
  assert.equal(pkg.scripts.dev, "next dev -H 127.0.0.1");
  assert.equal(pkg.scripts.build, "next build");
  assert.equal(pkg.scripts["build:desktop"], "tsc -p tsconfig.desktop.json");
  assert.equal(
    pkg.scripts["make:windows"],
    "npm run build && npm run build:standalone && npm run build:desktop && npm run build:audio-bridge && npm run prepare:prerequisites && electron-builder --win nsis --x64 && npm run test:packaged-runtime",
  );
});
