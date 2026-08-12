import assert from "node:assert/strict";
import test from "node:test";

import { filterMeetingProcesses } from "../../desktop/audio/meeting-processes.ts";

test("lists supported visible meeting processes and keeps duplicate instances", () => {
  const result = filterMeetingProcesses([
    { pid: 10, name: "Teams.exe", title: "Interview" },
    { pid: 11, name: "Teams.exe", title: "Second call" },
    { pid: 12, name: "notepad.exe", title: "Notes" },
    { pid: 13, name: "WeMeetApp.exe", title: "" },
    { pid: 14, name: 123, title: "Malformed process" },
    null
  ]);
  assert.deepEqual(result.map((item) => item.pid), [10, 11]);
});
