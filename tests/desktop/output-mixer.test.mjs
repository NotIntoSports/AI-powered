import assert from "node:assert/strict";
import test from "node:test";

import { selectOutputRoute } from "../../desktop/audio/output-mixer.ts";

test("human microphone always wins over TTS", () => {
  assert.equal(selectOutputRoute({ muted: false, humanMic: true, tts: true }), "human-mic");
  assert.equal(selectOutputRoute({ muted: false, humanMic: false, tts: true }), "tts");
  assert.equal(selectOutputRoute({ muted: true, humanMic: true, tts: true }), "silent");
});
