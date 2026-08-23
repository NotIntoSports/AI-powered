// 阿里云 CosyVoice 声音复刻最小集成验证（AGENTS.md 要求先行）。
// 用法：
//   node scripts/smoke-aliyun-cosyvoice.mjs                  # 验证 token + ListCosyVoice POP 签名 + CosyVoice 合成
//   COSYVOICE_SAMPLE_URL=<公网可访问的WAV> node scripts/smoke-aliyun-cosyvoice.mjs  # 追加验证 CosyVoiceClone
// 样例 URL 可用 control-api 的 POST /api/v1/client/voice-samples 返回的预签名 URL。
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import ts from "typescript";

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
const sampleUrl = (process.env.COSYVOICE_SAMPLE_URL || "").trim();

if (!appKey || !accessKeyId || !accessKeySecret) {
  process.stderr.write("阿里云语音缺配置。请在 .env.local 填写 ALIYUN_NLS_APPKEY、ALIYUN_NLS_ACCESS_KEY_ID、ALIYUN_NLS_ACCESS_KEY_SECRET。\n");
  process.exit(2);
}

// 与 smoke-aliyun-nls.mjs 相同：把 lib 源码转译成 ESM 后动态导入。
const dir = await mkdtemp(path.join(os.tmpdir(), "aliyun-cosyvoice-smoke-"));
const compilerOptions = { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 };
for (const name of ["aliyun-nls", "aliyun-cosyvoice"]) {
  const source = await readFile(path.join("lib", `${name}.ts`), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions }).outputText
    .replace(/from\s+"\.\/(aliyun-[a-z]+)"/g, "from \"./$1.mjs\"");
  await writeFile(path.join(dir, `${name}.mjs`), compiled);
}
const cosy = await import(pathToFileURL(path.join(dir, "aliyun-cosyvoice.mjs")).href);
const nls = await import(pathToFileURL(path.join(dir, "aliyun-nls.mjs")).href);

const auth = { appKey, accessKeyId, accessKeySecret };

const resolved = await nls.resolveAliyunNlsToken(auth);
if (!resolved.id) throw new Error("token empty");
process.stdout.write("token: ok\n");

const list = await cosy.listCosyVoice({ accessKeyId, accessKeySecret }, { pageIndex: 1, pageSize: 20 });
process.stdout.write(`list: ok (totalCount=${list.totalCount}${list.voices.length ? `, first=${list.voices[0].voiceName}` : ""})\n`);

let voice = list.voices.find((item) => item.status === "" || /OK|SUCCESS|AVAILABLE/i.test(item.status))?.voiceName || list.voices[0]?.voiceName || "";

if (sampleUrl) {
  const sampleResponse = await fetch(sampleUrl, { signal: AbortSignal.timeout(15_000) });
  const sampleBytes = new Uint8Array(await sampleResponse.arrayBuffer());
  if (!sampleResponse.ok || sampleBytes.length < 44) throw new Error(`sample url unreachable: ${sampleResponse.status}`);
  process.stdout.write(`sample-url: ok (${sampleBytes.byteLength} bytes, 阿里云可拉取)\n`);
  voice = await cosy.cloneCosyVoice({ accessKeyId, accessKeySecret }, { url: sampleUrl });
  process.stdout.write(`clone: ok (voiceName=${voice})\n`);
} else {
  voice = voice || "longxiaochun";
  process.stdout.write("clone: skipped（设置 COSYVOICE_SAMPLE_URL 可验证 CosyVoiceClone）\n");
}

let wav;
try {
  wav = await cosy.synthesizeCosyVoiceSpeech({ ...auth, voice }, "你好，这是复刻音色连通测试。");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/FREE_TRIAL_EXPIRED|40000010|商用版/.test(message)) {
    process.stdout.write(`tts: blocked (${message})\n`);
    process.stdout.write("阿里云 CosyVoice 大模型商用版未开通：请在控制台「智能语音交互 → 语音合成 CosyVoice 大模型」开通商用版后重跑本脚本。token/POP 签名/WebSocket 协议均已验证通过。\n");
    process.exit(3);
  }
  throw error;
}
if (wav.byteLength < 1024) throw new Error("synthesis audio too small");
const outputPath = path.join(dir, "cosyvoice-smoke.wav");
await writeFile(outputPath, wav);
process.stdout.write(`tts: ok (${wav.byteLength} bytes, voice=${voice}, saved=${outputPath})\n`);
process.stdout.write("aliyun cosyvoice smoke passed\n");
