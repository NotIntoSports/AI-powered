import assert from "node:assert/strict";
import test from "node:test";

import { encodeAgentCommand, parseAgentCommandResult } from "../../lib/agent-command/contract.ts";

test("agent command encoder excludes model configuration", () => {
  const payload = JSON.parse(new TextDecoder().decode(encodeAgentCommand({ id: "cmd-1", action: "say", text: "你好", expectedRevision: 1 })));
  assert.deepEqual(payload, { v: 1, id: "cmd-1", action: "say", text: "你好", expectedRevision: 1 });
  assert.equal("modelId" in payload, false);
});

test("agent command result parser preserves correlation", () => {
  const parsed = parseAgentCommandResult({ v: 1, commandId: "cmd-1", action: "retry", ok: true, result: { question: "下一题" }, error: "" });
  assert.equal(parsed?.commandId, "cmd-1");
  assert.equal(parsed?.result.question, "下一题");
});
