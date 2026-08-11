import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile("lib/model-output.ts", "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022
  }
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
const {
  isSensitiveHiringQuestion,
  sanitizeInterviewQuestion,
  stripHiddenReasoning
} = await import(moduleUrl);

assert.equal(
  sanitizeInterviewQuestion(
    "<think>private analysis</think>\n### 问题\n- 请具体说明你负责的部分？\n- 第二个问题？"
  ),
  "请具体说明你负责的部分？"
);
for (const question of [
  "你今年多大了？",
  "你有结婚生孩子的计划吗？",
  "你的宗教信仰是什么？",
  "请介绍一下你的家庭情况？",
  "你的身体健康状况怎么样？",
  "你父母是做什么工作的？"
]) {
  assert.equal(isSensitiveHiringQuestion(question), true, question);
}
for (const question of [
  "请说明你在健康管理系统中负责的模块？",
  "这个产品主要服务哪个年龄段的用户？",
  "你如何为残障用户改进页面无障碍体验？",
  "你如何处理团队成员对技术方案的不同信仰？"
]) {
  assert.equal(isSensitiveHiringQuestion(question), false, question);
}
assert.equal(
  sanitizeInterviewQuestion("问题：**你为什么选择这个方案？**"),
  "你为什么选择这个方案？"
);
assert.equal(
  sanitizeInterviewQuestion("请介绍你承担的主要工作"),
  "请介绍你承担的主要工作？"
);
assert.throws(
  () => sanitizeInterviewQuestion("<think>尚未结束的内部推理"),
  /EMPTY_MODEL_RESPONSE/
);
assert.ok(Array.from(sanitizeInterviewQuestion("请说明" + "非常具体的工作内容".repeat(20))).length <= 80);
assert.equal(
  stripHiddenReasoning(
    '<reasoning>{"wrong":true}</reasoning>{"summary":"ok"}'
  ),
  '{"summary":"ok"}'
);

process.stdout.write("model output sanitization test passed\n");
