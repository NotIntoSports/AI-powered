import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = dirname(fileURLToPath(import.meta.url));

test("desktop resume panel can list, view, delete, and re-upload", async () => {
  const source = await readFile(join(root, "../../features/resume/resume-upload.tsx"), "utf8");
  assert.match(source, /fetch\("\/api\/resume"/);
  assert.match(source, /method: "POST"/);
  assert.match(source, /method: "DELETE"/);
  assert.match(source, /查看\s*<\/button>/);
  assert.match(source, /删除\s*<\/button>/);
  assert.match(source, /上传新简历/);
  assert.match(source, /确定删除这份简历/);
  assert.match(source, /用于本场/);
});

test("desktop knowledge search proxy does not log chunk text or expose storage keys", async () => {
  const searchSource = await readFile(join(root, "../../app/api/knowledge/search/route.ts"), "utf8");
  const libSource = await readFile(join(root, "../../lib/knowledge.ts"), "utf8");
  assert.match(searchSource, /\/api\/v1\/client\/knowledge\/search/);
  assert.doesNotMatch(searchSource, /SecretKey|SECRET_KEY|console\.log/);
  assert.match(libSource, /searchResumeKnowledge/);
  assert.doesNotMatch(libSource, /console\.log/);
});

test("desktop resume APIs proxy list, download, and delete without exposing storage keys", async () => {
  const listSource = await readFile(join(root, "../../app/api/resume/route.ts"), "utf8");
  const itemSource = await readFile(join(root, "../../app/api/resume/[id]/route.ts"), "utf8");
  assert.match(listSource, /forwardControlResume\("\/api\/v1\/client\/resumes"\)/);
  assert.match(itemSource, /\/download/);
  assert.match(itemSource, /method: "DELETE"/);
  assert.doesNotMatch(listSource, /SecretKey|SECRET_KEY|cos-js-sdk/);
  assert.doesNotMatch(itemSource, /SecretKey|SECRET_KEY|cos-js-sdk/);
});
