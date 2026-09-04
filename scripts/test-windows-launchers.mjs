import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const start = await readFile("Start-AI-Virtual-Assistant.cmd", "utf8");
const check = await readFile("Check-AI-Virtual-Assistant.cmd", "utf8");
const setup = await readFile("First-Time-Setup.cmd", "utf8");
const legacyStart = await readFile("Start-AI-Interviewer.cmd", "utf8");
const legacyCheck = await readFile("Check-AI-Interviewer.cmd", "utf8");

for (const content of [start, check, setup]) {
  assert.match(content, /cd \/d "%~dp0"/i);
  assert.doesNotMatch(content, /\b(?:curl|wget|irm|iex)\b/i);
}
assert.match(start, /scripts\\start-windows\.ps1/i);
assert.match(start, /AI Virtual Assistant/i);
assert.match(check, /scripts\\check-environment\.ps1/i);
assert.match(check, /AI Virtual Assistant/i);
assert.match(setup, /choice \/C YQ/i);
assert.match(setup, /scripts\\setup-windows\.ps1/i);
assert.doesNotMatch(setup, /whisper|ollama|local model|model download|SkipWhisper/i);
assert.match(legacyStart, /Start-AI-Virtual-Assistant\.cmd/i);
assert.match(legacyCheck, /Check-AI-Virtual-Assistant\.cmd/i);

const windowsSetup = await readFile("scripts/setup-windows.ps1", "utf8");
assert.match(windowsSetup, /ensure-node\.ps1/i);
assert.ok(
  windowsSetup.indexOf("ensure-node.ps1") < windowsSetup.indexOf("Installing project dependencies"),
  "Node.js must be bootstrapped before npm install"
);

const windowsStart = await readFile("scripts/start-windows.ps1", "utf8");
assert.match(windowsStart, /ConvertFrom-Json/i);
assert.match(windowsStart, /health\.service\s+-eq\s+'authorized-interview-screen-helper'/i);
assert.match(windowsStart, /health\.status\s+-eq\s+'ok'/i);
assert.match(windowsStart, /CloseMainWindow\(\)/i);
assert.match(windowsStart, /obs-secret-store\.mjs/i);
assert.match(windowsStart, /Node\.js 22\.13\.0 or newer/i);
assert.match(windowsStart, /AI Virtual Assistant/i);
assert.doesNotMatch(windowsStart, /Stop-Process[^\r\n]*obs64/i);
assert.doesNotMatch(windowsStart, /whisper|TRANSCRIPTION_PROVIDER/i);

const windowsStop = await readFile("scripts/stop-windows.ps1", "utf8");
assert.doesNotMatch(windowsStop, /whisper/i);
const stopFunction = windowsStop.slice(
  windowsStop.indexOf("function Stop-RecordedProcess"),
  windowsStop.indexOf("Stop-RecordedProcess -PidPath")
);
assert.ok(
  stopFunction.indexOf("Test-Path -LiteralPath $PidPath") <
    stopFunction.indexOf("Get-PortOwner $FallbackPort"),
  "stop must prefer the recorded project PID before the default-port fallback"
);

process.stdout.write("Windows double-click launcher test passed\n");
