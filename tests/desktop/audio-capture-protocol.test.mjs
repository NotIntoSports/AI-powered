import assert from "node:assert/strict";
import test from "node:test";

import { parseCaptureEvent, serializeCaptureCommand } from "../../desktop/audio/capture-protocol.ts";

test("serializes process-tree capture commands", () => {
  const line = serializeCaptureCommand({
    type: "start",
    pid: 1234,
    scope: "process-tree",
    format: { sampleRate: 48000, channels: 1, frameMs: 10 }
  });
  assert.equal(line.endsWith("\n"), true);
  assert.equal(JSON.parse(line).pid, 1234);
});

test("validates sequenced audio level and exit events", () => {
  assert.deepEqual(parseCaptureEvent('{"type":"level","sequence":9,"peak":0.5}\n'), {
    type: "level", sequence: 9, peak: 0.5
  });
  assert.deepEqual(parseCaptureEvent('{"type":"process-exited","sequence":10}\n'), {
    type: "process-exited", sequence: 10
  });
  assert.throws(() => parseCaptureEvent('{"type":"level","sequence":-1,"peak":2}'));
});
