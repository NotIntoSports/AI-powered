import assert from "node:assert/strict";
import test from "node:test";

import { reconcileVirtualCameraState } from "../../desktop/virtual-camera-state.ts";

function fakeClient(statuses, commandError) {
  const calls = [];
  return {
    calls,
    async call(requestType) {
      calls.push(requestType);
      if (requestType === "GetVirtualCamStatus") {
        return { outputActive: statuses.length > 1 ? statuses.shift() : statuses[0] };
      }
      if (commandError) throw commandError;
      return undefined;
    }
  };
}

const immediateWait = async () => {};

test("accepts delayed virtual camera activation after StartVirtualCam reports an error", async () => {
  const client = fakeClient([false, false, true], new Error("start returned failure"));
  await reconcileVirtualCameraState(client, true, { timeoutMs: 2_000, pollIntervalMs: 100, wait: immediateWait });
  assert.deepEqual(client.calls, ["GetVirtualCamStatus", "StartVirtualCam", "GetVirtualCamStatus", "GetVirtualCamStatus"]);
});

test("polls final state without waiting for a StartVirtualCam response", async () => {
  const calls = [];
  const client = {
    async call(requestType) {
      calls.push(requestType);
      if (requestType === "StartVirtualCam") return new Promise(() => {});
      return { outputActive: calls.filter((call) => call === "GetVirtualCamStatus").length >= 2 };
    }
  };
  await reconcileVirtualCameraState(client, true, { timeoutMs: 200, pollIntervalMs: 100, wait: immediateWait });
  assert.deepEqual(calls, ["GetVirtualCamStatus", "StartVirtualCam", "GetVirtualCamStatus"]);
});

test("returns immediately when the virtual camera already matches", async () => {
  const client = fakeClient([true]);
  await reconcileVirtualCameraState(client, true, { wait: immediateWait });
  assert.deepEqual(client.calls, ["GetVirtualCamStatus"]);
});

test("waits for delayed virtual camera shutdown", async () => {
  const client = fakeClient([true, true, false]);
  await reconcileVirtualCameraState(client, false, { timeoutMs: 2_000, pollIntervalMs: 100, wait: immediateWait });
  assert.deepEqual(client.calls, ["GetVirtualCamStatus", "StopVirtualCam", "GetVirtualCamStatus", "GetVirtualCamStatus"]);
});

test("fails only after the virtual camera remains mismatched through the deadline", async () => {
  const client = fakeClient([false]);
  await assert.rejects(
    reconcileVirtualCameraState(client, true, { timeoutMs: 200, pollIntervalMs: 100, wait: immediateWait }),
    /did not become active/
  );
  assert.equal(client.calls.filter((call) => call === "GetVirtualCamStatus").length, 3);
});

test("does not hide status query failures", async () => {
  const client = { async call() { throw new Error("status unavailable"); } };
  await assert.rejects(reconcileVirtualCameraState(client, true, { wait: immediateWait }), /status unavailable/);
});
