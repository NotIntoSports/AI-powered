import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildServerEnvironment,
  getAvailableLoopbackPort,
  LocalServerStartError,
  sanitizeServerOutput,
  startLocalServer,
  stopOwnedProcess
} from "../../desktop/server-process.ts";

test("selects an available loopback port", async () => {
  const port = await getAvailableLoopbackPort();
  assert.ok(Number.isInteger(port));
  assert.ok(port > 0 && port <= 65535);
});

test("builds an Electron-as-Node server environment", () => {
  const environment = buildServerEnvironment(43123, { SAMPLE: "yes" });
  assert.equal(environment.HOSTNAME, "127.0.0.1");
  assert.equal(environment.PORT, "43123");
  assert.equal(environment.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(environment.SAMPLE, "yes");
});

test("only stops a process owned by the desktop client", async () => {
  let killed = false;
  await stopOwnedProcess({ owned: false, child: { kill: () => { killed = true; } } });
  assert.equal(killed, false);

  await stopOwnedProcess({ owned: true, child: { kill: () => { killed = true; } } });
  assert.equal(killed, true);
});

test("redacts credentials from local server diagnostics", () => {
  const output = sanitizeServerOutput(
    "Authorization: Bearer secret-token API_KEY=super-secret https://user:pass@example.com/path"
  );
  assert.doesNotMatch(output, /secret-token|super-secret|user:pass/);
  assert.match(output, /Bearer \[REDACTED\]/);
  assert.match(output, /API_KEY=\[REDACTED\]/);
});

test("captures an early server failure in a diagnostic log", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ai-interviewer-server-"));
  const serverPath = path.join(directory, "broken-server.cjs");
  const logPath = path.join(directory, "startup.log");
  await writeFile(
    serverPath,
    "console.error('Cannot find module runtime-dependency API_KEY=do-not-log'); process.exit(1);"
  );

  await assert.rejects(
    startLocalServer({
      executablePath: process.execPath,
      serverPath,
      cwd: directory,
      logPath,
      timeoutMs: 2_000
    }),
    (error) => {
      assert.ok(error instanceof LocalServerStartError);
      assert.equal(error.logPath, logPath);
      assert.match(error.message, /Cannot find module runtime-dependency/);
      assert.doesNotMatch(error.message, /do-not-log/);
      return true;
    }
  );

  const log = await readFile(logPath, "utf8");
  assert.match(log, /Cannot find module runtime-dependency/);
  assert.doesNotMatch(log, /do-not-log/);
});
