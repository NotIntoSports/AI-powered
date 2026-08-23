import assert from "node:assert/strict";
import test from "node:test";

import {
  assistantRoleIds,
  builtInRoleProfiles,
  renderRoleTemplate,
  validateRoleTemplate
} from "../../lib/assistant-role.ts";

test("exposes the four supported assistant roles", () => {
  assert.deepEqual(assistantRoleIds, ["hr", "meeting_assistant", "interviewer", "candidate"]);
  assert.deepEqual(Object.keys(builtInRoleProfiles), assistantRoleIds);
});

test("renders only target and topic placeholders", () => {
  assert.equal(
    renderRoleTemplate("你好 {{target}}，讨论 {{topic}}。", { target: "小王", topic: "前端岗位" }),
    "你好 小王，讨论 前端岗位。"
  );
  assert.equal(validateRoleTemplate("{{target}} / {{topic}}"), true);
  assert.equal(validateRoleTemplate("{{secret}}"), false);
});

test("built-in profiles have distinct role contracts and copy", () => {
  assert.match(builtInRoleProfiles.hr.instructions, /招聘|岗位/);
  assert.match(builtInRoleProfiles.meeting_assistant.instructions, /议题|行动项/);
  assert.match(builtInRoleProfiles.interviewer.instructions, /能力|经历/);
  assert.match(builtInRoleProfiles.candidate.instructions, /第一人称|回答/);
  assert.notEqual(builtInRoleProfiles.candidate.openingTemplate, builtInRoleProfiles.interviewer.openingTemplate);
});
