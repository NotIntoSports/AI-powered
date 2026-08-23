import assert from "node:assert/strict";
import test from "node:test";

// auto-bridge-store 依赖 window/localStorage；Node 环境下用最小桩替代浏览器环境。
const storage = new Map();
const dispatched = [];
globalThis.window = {
  localStorage: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key)
  },
  dispatchEvent: (event) => { dispatched.push(event.type); return true; },
  addEventListener: () => undefined,
  removeEventListener: () => undefined
};

const {
  armAutoBridge,
  disarmAutoBridge,
  loadAutoBridgeEnabled,
  loadAutoBridgeSoftware
} = await import("../../features/rtc/auto-bridge-store.ts");

test("armAutoBridge writes software and enabled together (case-insensitive)", () => {
  dispatched.length = 0;
  const armed = armAutoBridge("WeMeetApp.exe");
  assert.equal(armed, "wemeetapp.exe");
  assert.equal(loadAutoBridgeSoftware(), "wemeetapp.exe");
  assert.equal(loadAutoBridgeEnabled(), true);
  assert.ok(dispatched.includes("ai-auto-bridge-change"));
});

test("armAutoBridge rejects values outside the whitelist", () => {
  const armed = armAutoBridge("notepad.exe");
  assert.equal(armed, "");
  assert.equal(loadAutoBridgeSoftware(), "");
  assert.equal(loadAutoBridgeEnabled(), false);
});

test("disarmAutoBridge clears software and disables auto capture", () => {
  armAutoBridge("feishu.exe");
  assert.equal(loadAutoBridgeEnabled(), true);
  disarmAutoBridge();
  assert.equal(loadAutoBridgeSoftware(), "");
  assert.equal(loadAutoBridgeEnabled(), false);
});

test("arm after disarm re-arms atomically", () => {
  disarmAutoBridge();
  armAutoBridge("zoom.exe");
  assert.equal(loadAutoBridgeSoftware(), "zoom.exe");
  assert.equal(loadAutoBridgeEnabled(), true);
});
