import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

if (process.platform !== "win32") {
  process.stdout.write("Windows UTF-8 stdio test skipped on non-Windows\n");
  process.exit(0);
}

const sample = "中文面试测试·API密钥";
const probe = [
  "$utf8 = New-Object Text.UTF8Encoding($false)",
  "[Console]::InputEncoding = $utf8",
  "[Console]::OutputEncoding = $utf8",
  "[Console]::Out.Write([Console]::In.ReadToEnd())"
].join("; ");
const result = spawnSync(
  "powershell.exe",
  ["-NoProfile", "-NonInteractive", "-Command", probe],
  { input: sample, encoding: "utf8", windowsHide: true }
);
assert.equal(result.status, 0);
assert.equal(result.stdout, sample);

const protectedValue = spawnSync(
  "powershell.exe",
  [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    "scripts/dpapi-secret.ps1",
    "-Mode",
    "Protect"
  ],
  { input: sample, encoding: "utf8", windowsHide: true }
);
assert.equal(protectedValue.status, 0);
assert.equal(protectedValue.stdout.includes(sample), false);
const unprotectedValue = spawnSync(
  "powershell.exe",
  [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    "scripts/dpapi-secret.ps1",
    "-Mode",
    "Unprotect"
  ],
  { input: protectedValue.stdout, encoding: "utf8", windowsHide: true }
);
assert.equal(unprotectedValue.status, 0);
assert.equal(unprotectedValue.stdout, sample);

const voiceList = spawnSync(
  "powershell.exe",
  [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    "scripts/sapi-voices.ps1"
  ],
  { encoding: "utf8", windowsHide: true }
);
assert.equal(voiceList.status, 0);
const voices = JSON.parse(voiceList.stdout);
assert.ok(Array.isArray(voices));
assert.ok(voices.length > 0);
assert.ok(voices.every((voice) => voice.culture === "zh-CN" && voice.name));

const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "ai-interview-sapi-"));
try {
  for (const forceCom of [false, true]) {
    const outputPath = path.join(
      temporaryDirectory,
      forceCom ? "com-fallback.wav" : "system-speech.wav"
    );
    const synthesis = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "scripts/sapi-tts.ps1",
        "-OutputPath",
        outputPath,
        ...(forceCom ? ["-ForceCom"] : [])
      ],
      { input: sample, encoding: "utf8", windowsHide: true }
    );
    assert.equal(synthesis.status, 0, synthesis.stderr);
    const wav = await readFile(outputPath);
    assert.ok(wav.byteLength > 1_000);
    assert.equal(wav.subarray(0, 4).toString("ascii"), "RIFF");
    assert.equal(wav.subarray(8, 12).toString("ascii"), "WAVE");
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

process.stdout.write("Windows UTF-8 stdio and DPAPI test passed\n");
