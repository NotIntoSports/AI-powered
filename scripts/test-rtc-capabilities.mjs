import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile("lib/rtc/rtc-capabilities.ts", "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 }
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
const { VOLCENGINE_RTC_CAPABILITIES, isRtcReleaseAllowed } = await import(moduleUrl);

assert.equal(VOLCENGINE_RTC_CAPABILITIES.packageName, "@volcengine/rtc");
assert.equal(VOLCENGINE_RTC_CAPABILITIES.version, "4.69.0");
assert.equal(VOLCENGINE_RTC_CAPABILITIES.license, "BSD-3-Clause");
assert.equal(isRtcReleaseAllowed(VOLCENGINE_RTC_CAPABILITIES), true);
assert.equal(isRtcReleaseAllowed({ ...VOLCENGINE_RTC_CAPABILITIES, subtitles: false }), false);
assert.equal(isRtcReleaseAllowed({ ...VOLCENGINE_RTC_CAPABILITIES, redistributable: false }), false);

const declarations = await readFile("node_modules/@volcengine/rtc/index.d.ts", "utf8");
for (const api of ["setExternalAudioTrack", "setAudioSourceType", "startSubtitle", "onSubtitleMessageReceived"]) {
  assert.match(declarations, new RegExp(api));
}

process.stdout.write("Volcengine RTC capability gate passed\n");
