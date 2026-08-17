import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";

function parseEnvFile(text) {
  const env = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

const envPath = path.join(process.cwd(), ".env.local");
const fileEnv = parseEnvFile(await readFile(envPath, "utf8").catch(() => ""));
for (const [key, value] of Object.entries(fileEnv)) {
  if (!process.env[key]) process.env[key] = value;
}

const appKey = (process.env.ALIYUN_NLS_APPKEY || "").trim();
const accessKeyId = (process.env.ALIYUN_NLS_ACCESS_KEY_ID || process.env.ALIYUN_AK_ID || "").trim();
const accessKeySecret = (process.env.ALIYUN_NLS_ACCESS_KEY_SECRET || process.env.ALIYUN_AK_SECRET || "").trim();
const token = (process.env.ALIYUN_NLS_TOKEN || "").trim();
const voice = (process.env.ALIYUN_NLS_VOICE || "xiaoyun").trim();

if (!appKey) {
  process.stderr.write("ALIYUN_NLS_APPKEY 未配置。请把控制台 Appkey 写入 .env.local。\n");
  process.exit(2);
}
if (!token && (!accessKeyId || !accessKeySecret)) {
  process.stderr.write("阿里云语音还缺 AccessKey。请在 .env.local 填写 ALIYUN_NLS_ACCESS_KEY_ID 和 ALIYUN_NLS_ACCESS_KEY_SECRET，或填写 24 小时有效的 ALIYUN_NLS_TOKEN。\n");
  process.exit(2);
}

const dir = await mkdtemp(path.join(os.tmpdir(), "aliyun-nls-smoke-"));
const source = await readFile(path.join("lib", "aliyun-nls.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022
  }
}).outputText;
await writeFile(path.join(dir, "aliyun-nls.mjs"), compiled);
const nls = await import(pathToFileURL(path.join(dir, "aliyun-nls.mjs")).href);

const auth = {
  appKey,
  accessKeyId,
  accessKeySecret,
  token,
  voice
};

const resolved = await nls.resolveAliyunNlsToken(auth);
if (!resolved.id) throw new Error("token empty");
process.stdout.write("token: ok\n");

const sample = "你好，这是阿里云语音合成连通测试。";
const wav = await nls.synthesizeAliyunSpeech(auth, sample);
if (!nls.isAliyunTtsAudio("audio/wav", wav)) throw new Error("tts audio invalid");
process.stdout.write(`tts: ok (${wav.byteLength} bytes, voice=${voice})\n`);

const text = await nls.recognizeAliyunSpeech(auth, wav, "wav", nls.parseWavSampleRate(wav));
process.stdout.write(`asr: ${text || "(empty)"}\n`);
if (!text) throw new Error("asr empty");
process.stdout.write("aliyun nls smoke passed\n");
