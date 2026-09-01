import assert from "node:assert/strict";
import test from "node:test";
import { CommunicationsMicrophoneRouter } from "../../desktop/audio/communications-microphone-router.ts";

test("routes only the selected meeting and restores the previous communications microphone", async () => {
  const calls = [];
  const router = new CommunicationsMicrophoneRouter(async (_exe, args) => {
    calls.push(args);
    return args[0] === "--set-default-communications-mic"
      ? { stdout: JSON.stringify({ changed: true, previousId: "physical", cableId: "cable", cableLabel: "CABLE Output" }), stderr: "" }
      : { stdout: "", stderr: "" };
  });
  await router.activate("bridge.exe", 42);
  await router.activate("bridge.exe", 42);
  await router.restore("bridge.exe");
  assert.deepEqual(calls, [
    ["--set-default-communications-mic"],
    ["--restore-default-communications-mic", "physical"],
  ]);
});

test("switching selected meetings restores before applying the new route", async () => {
  const calls = [];
  const router = new CommunicationsMicrophoneRouter(async (_exe, args) => {
    calls.push(args);
    return { stdout: JSON.stringify({ changed: true, previousId: "physical", cableId: "cable", cableLabel: "CABLE Output" }), stderr: "" };
  });
  await router.activate("bridge.exe", 1);
  await router.activate("bridge.exe", 2);
  assert.deepEqual(calls.map((args) => args[0]), [
    "--set-default-communications-mic",
    "--restore-default-communications-mic",
    "--set-default-communications-mic",
  ]);
});
