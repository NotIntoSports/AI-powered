import test from "node:test";
import assert from "node:assert/strict";
import { MEETING_EXECUTABLE_NAMES as nodeNames } from "../../desktop/audio/meeting-processes.ts";
import { MEETING_EXECUTABLE_NAMES as rendererNames, MEETING_SOFTWARE_LABELS } from "../../desktop/audio/meeting-software.ts";

test("会议白名单：Node 侧与渲染进程侧常量一致", () => {
  assert.deepEqual([...nodeNames].sort(), [...rendererNames].sort());
});

test("会议白名单：每个可执行名都有显示名", () => {
  for (const name of rendererNames) {
    assert.ok(MEETING_SOFTWARE_LABELS[name], `缺少 ${name} 的显示名`);
  }
});
