import assert from "node:assert/strict";
import test from "node:test";

import {
  buildServerEnvironment,
  getAvailableLoopbackPort,
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
