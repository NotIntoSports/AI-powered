import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const windows = process.platform === "win32";
const ps = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"];
test("diagnostic fetch does not create directories or download missing archives", { skip: !windows }, () => {
  const root = mkdtempSync(join(tmpdir(), "audio-probe-"));
  const absent = join(root, "不存在 directory");
  try {
    assert.throws(() => execFileSync("powershell.exe", [...ps, "-File", resolve("scripts/fetch-prerequisites.ps1"), "-Component", "virtual-audio", "-Destination", absent, "-ProbeOnly"], { encoding: "utf8", windowsHide: true, timeout: 15000, stdio: "pipe" }), /PREREQUISITE_RESOURCE_MISSING/);
    assert.equal(existsSync(absent), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("preparation probe refuses a live elevated-worker lock without installing", { skip: !windows }, async () => {
  const code = String.raw`$m=[Threading.Mutex]::new($false,'Local\AI.VirtualAssistant.VirtualAudio.Worker'); $null=$m.WaitOne(); [Console]::WriteLine('locked'); [Console]::ReadLine() | Out-Null; $m.ReleaseMutex(); $m.Dispose()`;
  const holder = spawn("powershell.exe", [...ps, "-EncodedCommand", Buffer.from(code, "utf16le").toString("base64")], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  try {
    await new Promise((res, rej) => {
      const deadline = setTimeout(() => rej(new Error("lock holder did not start")), 10000);
      holder.stdout.once("data", () => { clearTimeout(deadline); res(); });
      holder.once("error", (error) => { clearTimeout(deadline); rej(error); });
    });
    assert.throws(() => execFileSync("powershell.exe", [...ps, "-File", resolve("scripts/install-prerequisite.ps1"), "-Component", "virtual-audio", "-ResourcesDirectory", tmpdir(), "-ProbeOnly"], { encoding: "utf8", windowsHide: true, timeout: 15000, stdio: "pipe" }), (error) => {
      const result = JSON.parse(error.stdout.trim());
      assert.equal(result.errorCode, "PREREQUISITE_INSTALL_BUSY");
      assert.equal(result.installed, false);
      return true;
    });
  } finally {
    holder.stdin.end("\n");
    await new Promise((res) => { holder.once("exit", res); setTimeout(() => { holder.kill(); res(); }, 2000).unref(); });
  }
});
