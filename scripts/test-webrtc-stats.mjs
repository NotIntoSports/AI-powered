import assert from "node:assert/strict";
import { summarizeRtcStats } from "../lib/webrtc-stats.ts";
import { describeNetwork, networkStatus } from "../features/rtc/network-quality.ts";

const report = [
  { type: "candidate-pair", nominated: true, currentRoundTripTime: 0.042 },
  { type: "inbound-rtp", packetsLost: 2, packetsReceived: 98 }
];

const stats = summarizeRtcStats([report]);
assert.equal(stats.rttMs, 42);
assert.equal(stats.packetLossPct, 2);
assert.equal(stats.packetsLost, 2);

assert.equal(networkStatus({
  managementReachable: true,
  managementRttMs: 40,
  rtcConnected: true,
  rtcRttMs: 42,
  packetLossPct: 0.2
}), "ok");
assert.equal(networkStatus({
  managementReachable: true,
  managementRttMs: 40,
  rtcConnected: true,
  rtcRttMs: 240,
  packetLossPct: 6
}), "warn");
assert.equal(networkStatus({
  managementReachable: false,
  managementRttMs: 1500,
  rtcConnected: false,
  rtcRttMs: null,
  packetLossPct: null
}), "bad");

assert.match(describeNetwork({
  managementReachable: true,
  managementRttMs: 38,
  rtcConnected: true,
  rtcRttMs: 42,
  packetLossPct: 1.5
}), /延时 42ms · 丢包 1.5%/);
assert.match(describeNetwork({
  managementReachable: true,
  managementRttMs: 38,
  rtcConnected: false,
  rtcRttMs: null,
  packetLossPct: null
}), /启动实时字幕后显示丢包/);

process.stdout.write("webrtc network stats test passed\n");
