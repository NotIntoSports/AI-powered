import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { applyLocalEnvFile, resolveDesktopEnvFiles } from "../../desktop/load-env.ts";

test("imports speech and control keys from dotenv without overwriting", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ai-env-"));
  const envPath = path.join(directory, ".env.local");
  await writeFile(
    envPath,
    [
      "# comment",
      "ALIYUN_NLS_APPKEY=app-from-file",
      "CONTROL_API_ORIGIN=http://example.test",
      "UNRELATED=skip-me",
      "SPEECH_PROVIDER=aliyun",
      ""
    ].join("\n")
  );
  const env = { ALIYUN_NLS_APPKEY: "keep-existing" };
  const applied = applyLocalEnvFile(envPath, env);
  assert.equal(applied, 2);
  assert.equal(env.ALIYUN_NLS_APPKEY, "keep-existing");
  assert.equal(env.CONTROL_API_ORIGIN, "http://example.test");
  assert.equal(env.SPEECH_PROVIDER, "aliyun");
  assert.equal(env.UNRELATED, undefined);
});

test("resolves env files under the project cwd", () => {
  const files = resolveDesktopEnvFiles("E:\\project");
  assert.deepEqual(files, ["E:\\project\\.env.local", "E:\\project\\.env"]);
});
