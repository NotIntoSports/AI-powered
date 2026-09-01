import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createTranscriptFollowState,
  isTranscriptNearBottom,
  reduceTranscriptFollowState,
} from "../../features/subtitles/scroll-follow.ts";

test("transcript follows while within the bottom threshold", () => {
  assert.equal(isTranscriptNearBottom({ scrollHeight: 1000, scrollTop: 550, clientHeight: 400 }), true);
  assert.equal(isTranscriptNearBottom({ scrollHeight: 1000, scrollTop: 400, clientHeight: 400 }), false);
});

test("programmatic scrolling and subtitle growth never enter history review", () => {
  let state = createTranscriptFollowState();
  state = reduceTranscriptFollowState(state, { type: "programmatic-start" });
  state = reduceTranscriptFollowState(state, { type: "scroll-position", nearBottom: false });
  assert.equal(state.mode, "programmatic-scroll");
  state = reduceTranscriptFollowState(state, { type: "programmatic-end", nearBottom: true });
  assert.equal(state.mode, "following");
  state = reduceTranscriptFollowState(state, { type: "content-resized" });
  assert.equal(state.mode, "following");
});

test("only explicit upward user intent pauses following and bottom restores it", () => {
  let state = createTranscriptFollowState();
  state = reduceTranscriptFollowState(state, { type: "scroll-position", nearBottom: false });
  assert.equal(state.mode, "following");
  state = reduceTranscriptFollowState(state, { type: "user-scroll-up" });
  state = reduceTranscriptFollowState(state, { type: "scroll-position", nearBottom: false });
  assert.equal(state.mode, "reviewing-history");
  state = reduceTranscriptFollowState(state, { type: "scroll-position", nearBottom: true });
  assert.equal(state.mode, "following");
});

test("workspace pauses following for history review and offers return to latest", async () => {
  const source = await readFile(new URL("../../app/page.tsx", import.meta.url), "utf8");
  assert.match(source, /isTranscriptNearBottom/);
  assert.match(source, /回到最新/);
  assert.match(source, /messagesRef/);
  assert.match(source, /ResizeObserver/);
  assert.match(source, /messagesContentRef/);
  assert.match(source, /requestAnimationFrame/);
  assert.match(source, /onWheel/);
});

test("transcript scrollbar uses a transparent track and translucent thumb", async () => {
  const styles = await readFile(new URL("../../app/styles.css", import.meta.url), "utf8");
  assert.match(styles, /\.messages::-webkit-scrollbar-track\s*\{[^}]*transparent/s);
  assert.match(styles, /\.messages::-webkit-scrollbar-thumb\s*\{[^}]*rgba/s);
  assert.match(styles, /\.message\s*\{[^}]*width:\s*100%[^}]*max-width:\s*none/s);
  assert.doesNotMatch(styles, /\.message\.candidate\s*\{[^}]*justify-self:\s*end/s);
});
