import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile("lib/interview-export.ts", "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022
  }
}).outputText.replace(/^import .*?;\r?\n/m, "");
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
const { interviewExportFilename, renderInterviewMarkdown } = await import(moduleUrl);

const markdown = renderInterviewMarkdown({
  sessionId: "session-1",
  revision: 1,
  status: "finished",
  speakingText: "",
  candidateName: "张/同学",
  roleName: "前端 *工程师*",
  jobDescription: "# 管理组件平台",
  interviewFocus: "性能",
  maxQuestions: 3,
  consentConfirmed: true,
  consentConfirmedAt: "2026-07-28T10:00:00.000Z",
  startedAt: "2026-07-28T10:00:00.000Z",
  finishedAt: "2026-07-28T10:30:00.000Z",
  transcript: [{
    role: "candidate",
    text: "# 这不是标题\n> 这不是报告引用",
    at: "2026-07-28T10:01:00.000Z"
  }],
  report: null
});

assert.match(markdown, /^# 面试记录/m);
assert.match(markdown, /\\# 这不是标题/);
assert.match(markdown, /\\> 这不是报告引用/);
assert.match(markdown, /不包含录用或淘汰建议/);
assert.equal(interviewExportFilename({
  candidateName: "张/同学",
  roleName: "前端 工程师"
}, "md"), "张-同学-前端-工程师.md");

process.stdout.write("interview markdown export test passed\n");
