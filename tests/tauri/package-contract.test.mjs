import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertAllowedProcessTree,
  assertBundleContainsNoPrivateFiles,
  assertIsolationArtifacts,
  buildIsolatedLaunchEnvironment,
  requirePackagedExecutable,
  verifyIsolationSupport,
} from "../../scripts/test-tauri-package.mjs";

test("missing packaged executable stops the smoke test", async () => {
  await assert.rejects(
    requirePackagedExecutable(join(tmpdir(), "missing-tauri-foundation.exe")),
    /Packaged executable does not exist/,
  );
});

test("bundle inspection rejects private runtime files", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "tauri-bundle-contract-"));
  try {
    await mkdir(join(fixture, "config"), { recursive: true });
    await writeFile(join(fixture, "config", "local.json"), "{}", "utf8");

    await assert.rejects(
      assertBundleContainsNoPrivateFiles(fixture),
      /config[\\/]local\.json/,
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("bundle inspection permits normal application artifacts", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "tauri-bundle-contract-"));
  try {
    await mkdir(join(fixture, "resources"), { recursive: true });
    await writeFile(join(fixture, "resources", "app.bin"), "foundation", "utf8");
    await assert.doesNotReject(assertBundleContainsNoPrivateFiles(fixture));
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("process inspection rejects forbidden service descendants", () => {
  assert.throws(
    () => assertAllowedProcessTree([
      { processId: 4100, parentProcessId: 4000, name: "role-ai-desktop.exe" },
      { processId: 4200, parentProcessId: 4100, name: "python.exe" },
    ]),
    /python\.exe/,
  );
});

test("unsupported executable marker is rejected before a probe can launch it", async () => {
  let probes = 0;
  await assert.rejects(
    verifyIsolationSupport("stale.exe", {
      readBinary: async () => Buffer.from("old release"),
      runProbe: async () => {
        probes += 1;
        return { stdout: "" };
      },
    }),
    /does not contain the isolation support marker/,
  );
  assert.equal(probes, 0);
});

test("isolation probe accepts only the exact advertised contract", async () => {
  const calls = [];
  await verifyIsolationSupport("supported.exe", {
    readBinary: async () => Buffer.from("prefix AI_VIRTUAL_ASSISTANT_ISOLATION_V1 suffix"),
    runProbe: async (...args) => {
      calls.push(args);
      return { stdout: "AI_VIRTUAL_ASSISTANT_ISOLATION_V1", stderr: "" };
    },
  });
  assert.deepEqual(calls[0][1], ["--check-isolation-support"]);
});

test("isolated launch environment replaces inherited path and WebView2 overrides", () => {
  assert.deepEqual(
    buildIsolatedLaunchEnvironment({
      Path: "C:\\Windows",
      SystemRoot: "C:\\Windows",
      APPDATA: "C:\\real-roaming",
      LOCALAPPDATA: "C:\\real-local",
      AI_VIRTUAL_ASSISTANT_CONFIG: "C:\\real-config.json",
      WEBVIEW2_USER_DATA_FOLDER: "C:\\real-webview",
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9222",
      WebView2_Browser_Executable_Folder: "C:\\untrusted-runtime",
    }, "C:\\isolated\\webview"),
    {
      Path: "C:\\Windows",
      SystemRoot: "C:\\Windows",
      WEBVIEW2_USER_DATA_FOLDER: "C:\\isolated\\webview",
    },
  );
});

test("isolation artifact validation accepts a complete isolated startup", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "tauri-isolation-contract-"));
  try {
    await mkdir(join(fixture, "data"), { recursive: true });
    await mkdir(join(fixture, "logs"), { recursive: true });
    await mkdir(join(fixture, "config"), { recursive: true });
    await mkdir(join(fixture, "webview"), { recursive: true });
    await writeFile(join(fixture, "data", "app.sqlite3"), "sqlite", "utf8");
    await writeFile(join(fixture, "config", "local.json"), "{}", "utf8");

    await assert.doesNotReject(assertIsolationArtifacts(fixture));
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("isolation artifact validation rejects missing startup evidence", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "tauri-isolation-contract-"));
  try {
    await mkdir(join(fixture, "data"), { recursive: true });
    await assert.rejects(assertIsolationArtifacts(fixture), /config[\\/]local\.json/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
