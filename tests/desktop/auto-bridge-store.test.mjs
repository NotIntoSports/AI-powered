import assert from "node:assert/strict";
import test from "node:test";

import {
  parseAutoBridgeEnabled,
  parseAutoBridgeSoftware,
  MEETING_EXECUTABLE_NAMES
} from "../../features/rtc/auto-bridge-store.ts";

test("auto bridge defaults to disabled with no preselected software", () => {
  assert.equal(parseAutoBridgeEnabled(null), false);
  assert.equal(parseAutoBridgeSoftware(null), "");
});

test("parses saved values", () => {
  assert.equal(parseAutoBridgeEnabled("1"), true);
  assert.equal(parseAutoBridgeEnabled("true"), true);
  assert.equal(parseAutoBridgeEnabled("0"), false);
  assert.equal(parseAutoBridgeSoftware("wemeetapp.exe"), "wemeetapp.exe");
});

test("rejects software outside the whitelist", () => {
  assert.equal(parseAutoBridgeSoftware("notepad.exe"), "");
  assert.equal(parseAutoBridgeSoftware("  "), "");
});

test("whitelist comes from the desktop module", () => {
  assert.ok(MEETING_EXECUTABLE_NAMES.has("wemeetapp.exe"));
});
