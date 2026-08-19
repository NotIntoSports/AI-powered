import assert from "node:assert/strict";
import test from "node:test";

import {
  initialAutoBridgeMachine,
  decideAutoBridge
} from "../../features/rtc/auto-bridge-decision.ts";

const base = { now: 1000, machine: initialAutoBridgeMachine() };
const wemeet = { pid: 11, name: "WeMeetApp.exe", title: "张三的会议" };

test("idle when disabled or no software preselected", () => {
  assert.equal(decideAutoBridge([wemeet], { ...base, enabled: false, software: "wemeetapp.exe" }).action, "idle");
  assert.equal(decideAutoBridge([wemeet], { ...base, enabled: true, software: "" }).action, "idle");
});

test("manual session yields: no trigger while a bridge session runs", () => {
  const decision = decideAutoBridge([wemeet], { ...base, enabled: true, software: "wemeetapp.exe", sessionRunning: true });
  assert.equal(decision.action, "holding");
});

test("triggers capture for matching process with non-empty title", () => {
  const decision = decideAutoBridge([wemeet], { ...base, enabled: true, software: "wemeetapp.exe" });
  assert.deepEqual(decision.action, { type: "start", pid: 11 });
});

test("name match is case-insensitive and ignores other software", () => {
  const zoom = { pid: 20, name: "zoom.exe", title: "call" };
  const decision = decideAutoBridge([zoom], { ...base, enabled: true, software: "wemeetapp.exe" });
  assert.equal(decision.action, "waiting");
});

test("ignores matching process with empty title", () => {
  const noTitle = { pid: 12, name: "WeMeetApp.exe", title: "" };
  const decision = decideAutoBridge([noTitle], { ...base, enabled: true, software: "wemeetapp.exe" });
  assert.equal(decision.action, "waiting");
});

test("keeps holding while captured pid is alive", () => {
  const machine = { ...initialAutoBridgeMachine(), capturedPid: 11 };
  const decision = decideAutoBridge([wemeet], { ...base, machine, enabled: true, software: "wemeetapp.exe" });
  assert.equal(decision.action, "holding");
});

test("stops when captured pid disappears", () => {
  const machine = { ...initialAutoBridgeMachine(), capturedPid: 11 };
  const decision = decideAutoBridge([], { ...base, machine, enabled: true, software: "wemeetapp.exe" });
  assert.equal(decision.action, "stop");
  assert.equal(decision.machine.capturedPid, null);
  assert.equal(decision.machine.attempts, 0);
});

test("waits out the 10s backoff, then retries", () => {
  const machine = { ...initialAutoBridgeMachine(), attempts: 1, lastFailureAt: 1000 };
  const blocked = decideAutoBridge([wemeet], { now: 5000, machine, enabled: true, software: "wemeetapp.exe" });
  assert.equal(blocked.action, "backoff");
  const retry = decideAutoBridge([wemeet], { now: 11_001, machine, enabled: true, software: "wemeetapp.exe" });
  assert.deepEqual(retry.action, { type: "start", pid: 11 });
});

test("needs manual after 3 attempts once backoff elapses", () => {
  const exhausted = { ...initialAutoBridgeMachine(), attempts: 3, lastFailureAt: 1000 };
  const blocked = decideAutoBridge([wemeet], { now: 99_999, machine: exhausted, enabled: true, software: "wemeetapp.exe" });
  assert.equal(blocked.action, "needs-manual");
  assert.equal(blocked.machine.awaitingManual, true);
});

test("new meeting re-arms after needs-manual", () => {
  const machine = { attempts: 3, lastFailureAt: 1000, awaitingManual: true, capturedPid: null };
  const other = { pid: 30, name: "WeMeetApp.exe", title: "下一场" };
  const decision = decideAutoBridge([other], { ...base, machine, enabled: true, software: "wemeetapp.exe" });
  assert.deepEqual(decision.action, { type: "start", pid: 30 });
  assert.equal(decision.machine.awaitingManual, false);
});
