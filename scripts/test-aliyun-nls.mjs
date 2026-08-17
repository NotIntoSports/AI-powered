import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const dir = await mkdtemp(path.join(os.tmpdir(), "aliyun-nls-test-"));
const source = await readFile(path.join("lib", "aliyun-nls.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022
  }
}).outputText;
await writeFile(path.join(dir, "aliyun-nls.mjs"), compiled);
const nls = await import(pathToFileURL(path.join(dir, "aliyun-nls.mjs")).href);

assert.equal(nls.percentEncode("2019-04-03T06:15:03Z"), "2019-04-03T06%3A15%3A03Z");
assert.equal(nls.percentEncode("a b"), "a%20b");
assert.equal(nls.percentEncode("*~"), "%2A~");
assert.equal(
  nls.canonicalQuery({ SignatureVersion: "1.0", Action: "CreateToken", AccessKeyId: "LTAI" }),
  "AccessKeyId=LTAI&Action=CreateToken&SignatureVersion=1.0"
);

const tokenRequest = nls.buildCreateTokenRequest({
  accessKeyId: "LTAItestkey",
  accessKeySecret: "testsecret",
  timestamp: "2019-04-03T06:15:03Z",
  nonce: "8d1e6a7a-f44e-40d5-aedb-fe4a1c80f434"
});
assert.equal(tokenRequest.stringToSign.startsWith("GET&%2F&"), true);
assert.match(tokenRequest.signature, /^[A-Za-z0-9+/=]+$/);
assert.equal(
  tokenRequest.signature,
  "KjcxMs8/vyjkFEh3OCW/VaUzv7o="
);

const parsedToken = nls.parseCreateTokenResponse({
  Token: { Id: "nls-token-id", ExpireTime: 1553592564 }
});
assert.equal(parsedToken.id, "nls-token-id");
assert.equal(parsedToken.expireTime, 1553592564);
assert.throws(() => nls.parseCreateTokenResponse({ Token: {} }));

assert.equal(nls.mapAliyunAsrFormat("audio/wav"), "wav");
assert.equal(nls.mapAliyunAsrFormat("audio/webm;codecs=opus"), "opus");
assert.equal(nls.mapAliyunAsrFormat("audio/mpeg"), "mp3");
assert.equal(nls.parseAliyunAsrText({ status: 20000000, result: " 你好，面试官 " }), "你好，面试官");
assert.throws(() => nls.parseAliyunAsrText({ status: 40000000, message: "GATEWAY_TIMEOUT" }));

const wav = Buffer.alloc(44);
wav.write("RIFF", 0);
wav.write("WAVE", 8);
wav.writeUInt32LE(16000, 24);
assert.equal(nls.parseWavSampleRate(wav), 16000);
assert.equal(nls.isAliyunTtsAudio("application/json", wav), true);
assert.equal(nls.isAliyunTtsAudio("audio/mpeg", Buffer.from("ID3")), true);

process.stdout.write("aliyun nls mapping test passed\n");
