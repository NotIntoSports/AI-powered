import assert from "node:assert/strict";
import test from "node:test";
import { parseRemoteMonitorEnabled } from "../../features/audio/remote-monitor.ts";

test("remote monitor defaults to enabled", () => {
  assert.equal(parseRemoteMonitorEnabled(null), true);
  assert.equal(parseRemoteMonitorEnabled("1"), true);
  assert.equal(parseRemoteMonitorEnabled("true"), true);
  assert.equal(parseRemoteMonitorEnabled("0"), false);
  assert.equal(parseRemoteMonitorEnabled("false"), false);
});
