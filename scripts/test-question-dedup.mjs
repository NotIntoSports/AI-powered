import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile("lib/question-dedup.ts", "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022
  }
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
const {
  isSubstantiallyDuplicateQuestion,
  normalizeInterviewQuestion,
  pickNonDuplicateFallback
} = await import(moduleUrl);

assert.equal(normalizeInterviewQuestion("请说明：你的贡献？"), "请说明你的贡献");
assert.equal(isSubstantiallyDuplicateQuestion(
  "请具体说明你在这个项目中负责的部分？",
  ["请具体说明，你在这个项目中负责的部分。"]
), true);
assert.equal(isSubstantiallyDuplicateQuestion(
  "在这个项目里，具体哪些部分由你负责？",
  ["请具体说明你在这个项目中负责的部分？"]
), false);
assert.equal(isSubstantiallyDuplicateQuestion(
  "你如何验证性能提升来自缓存策略？",
  ["请说明你在项目中负责的部分？"]
), false);
const fallback = pickNonDuplicateFallback([
  "请换一个不同的具体案例，说明你的个人贡献和量化结果？"
]);
assert.notEqual(fallback, "请换一个不同的具体案例，说明你的个人贡献和量化结果？");

process.stdout.write("question deduplication test passed\n");
