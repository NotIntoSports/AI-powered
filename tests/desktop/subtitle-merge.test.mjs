import assert from "node:assert/strict";
import test from "node:test";

import { mergeSubtitle } from "../../desktop/rtc/subtitle-merge.ts";

test("final subtitles replace partial text and cannot be overwritten by partials", () => {
  let state = mergeSubtitle([], { userId: "candidate", sequence: 1, text: "我有", definite: false, language: "zh" });
  state = mergeSubtitle(state, { userId: "candidate", sequence: 1, text: "我有三年经验", definite: true, language: "zh" });
  state = mergeSubtitle(state, { userId: "candidate", sequence: 1, text: "旧增量", definite: false, language: "zh" });
  assert.equal(state.length, 1);
  assert.equal(state[0].text, "我有三年经验");
  assert.equal(state[0].final, true);
});

test("orders different sequences", () => {
  let state = mergeSubtitle([], { userId: "candidate", sequence: 2, text: "二", definite: true, language: "zh" });
  state = mergeSubtitle(state, { userId: "candidate", sequence: 1, text: "一", definite: true, language: "zh" });
  assert.deepEqual(state.map((item) => item.sequence), [1, 2]);
});
