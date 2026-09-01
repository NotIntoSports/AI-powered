import assert from "node:assert/strict";
import test from "node:test";
import { AgentE2eQueue } from "../../features/rtc/agent-e2e-queue.ts";

test("agent result queue deduplicates and preserves FIFO order", () => {
  const queue = new AgentE2eQueue();
  const first = { sessionId: "s", utteranceId: "1", candidateText: "a", replyText: "r1" };
  const second = { sessionId: "s", utteranceId: "2", candidateText: "b", replyText: "r2" };
  assert.equal(queue.enqueue(first), true);
  assert.equal(queue.enqueue(first), false);
  assert.equal(queue.enqueue(second), true);
  assert.equal(queue.shift()?.utteranceId, "1");
  assert.equal(queue.shift()?.utteranceId, "2");
});

test("failed head can remain queued until an explicit retry", () => {
  const queue = new AgentE2eQueue();
  queue.enqueue({ sessionId: "s", utteranceId: "1", candidateText: "a", replyText: "r" });
  assert.equal(queue.peek()?.utteranceId, "1");
  assert.equal(queue.peek()?.utteranceId, "1");
  queue.clear();
  assert.equal(queue.size, 0);
});
