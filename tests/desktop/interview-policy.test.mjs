import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildOpeningMessage } from "../../features/session/interview-policy.ts";

test("AI disclosure changes opening copy without blocking the session", () => {
  const base = { candidateName: "小王", roleName: "产品交流" };
  assert.doesNotMatch(buildOpeningMessage({ ...base, consentConfirmed: false }), /AI|保存|人工复核/);
  assert.match(buildOpeningMessage({ ...base, consentConfirmed: true }), /AI虚拟助手协助.*保存.*人工复核/);
});

test("session API accepts false disclosure and always continues with another question", async () => {
  const source = await readFile(new URL("../../app/api/session/route.ts", import.meta.url), "utf8");
  assert.match(source, /consentConfirmed:\s*z\.boolean\(\)\.default\(false\)/);
  assert.doesNotMatch(source, /hasReachedQuestionLimit/);
  assert.doesNotMatch(source, /appendFinalAnswerAndFinish/);
  assert.doesNotMatch(source, /maxQuestions:\s*z\.number/);
});

test("exports omit the legacy question limit", async () => {
  const source = await readFile(new URL("../../lib/interview-export.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /问题上限/);
});
