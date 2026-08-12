import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { classifyPrerequisiteInstallError } from "../../desktop/prerequisites/install-error.ts";

test("classifies prerequisite installation failures without exposing unbounded output", () => {
  assert.equal(classifyPrerequisiteInstallError("PREREQUISITE_UAC_CANCELLED: cancelled").code, "uac-cancelled");
  assert.equal(classifyPrerequisiteInstallError("PREREQUISITE_RESOURCE_MISSING: VirtualAudioDriver.inf").code, "resource-missing");
  assert.equal(classifyPrerequisiteInstallError("PREREQUISITE_SIGNATURE_REJECTED: untrusted catalog").code, "signature-rejected");
  assert.equal(classifyPrerequisiteInstallError("PREREQUISITE_INSTALL_FAILED: pnputil failed").code, "install-failed");
  assert.equal(classifyPrerequisiteInstallError("unexpected").code, "unknown");
  assert.equal(classifyPrerequisiteInstallError(`PREREQUISITE_INSTALL_FAILED: ${"x".repeat(800)}`).message.length, 500);
});

test("keeps useful localized pnputil details", () => {
  const result = classifyPrerequisiteInstallError("PREREQUISITE_INSTALL_FAILED: 无法找到包含 空格、中文 和 & 符号的驱动路径");
  assert.equal(result.code, "install-failed");
  assert.match(result.message, /空格、中文/);
});

test("driver installer transports the INF path through JSON instead of command interpolation", async () => {
  const source = await readFile(new URL("../../scripts/install-prerequisite.ps1", import.meta.url), "utf8");
  assert.match(source, /infPath = \$inf\.FullName/);
  assert.match(source, /\/add-driver \$request\.infPath \/install/);
  assert.doesNotMatch(source, /-ArgumentList @\("\/add-driver", \$inf\.FullName/);
  assert.match(source, /FromBase64String\("__REQUEST_PATH__"\)/);
});
