import assert from "node:assert/strict";
import test from "node:test";

const resultModule = await import("../../lib/control-api-result.ts").catch(() => ({}));
const errorModule = await import("../../lib/voice-sample-errors.ts").catch(() => ({}));

test("control API failures preserve safe status and structured codes", async () => {
  assert.equal(typeof resultModule.parseControlApiResponse, "function");
  const response = new Response(JSON.stringify({ code: "STORAGE_UNCONFIGURED", message: "object storage is not configured", secretKey: "must-not-leak" }), {
    status: 503,
    headers: { "Content-Type": "application/json" }
  });
  const result = await resultModule.parseControlApiResponse(response);
  assert.deepEqual(result, {
    ok: false,
    failure: { status: 503, code: "STORAGE_UNCONFIGURED", message: "object storage is not configured" }
  });
  assert.equal(JSON.stringify(result).includes("must-not-leak"), false);
});

test("voice sample failures map authentication, version, storage and server errors separately", () => {
  assert.equal(typeof errorModule.voiceSampleUploadFailureMessage, "function");
  assert.equal(errorModule.voiceSampleUploadFailureMessage({ status: 401, code: "UNAUTHENTICATED", message: "" }), "登录已过期，请重新登录后再提交刻录");
  assert.equal(errorModule.voiceSampleUploadFailureMessage({ status: 404, code: "NOT_FOUND", message: "" }), "声音刻录服务版本未更新，请联系管理员更新服务");
  assert.equal(errorModule.voiceSampleUploadFailureMessage({ status: 503, code: "STORAGE_UNCONFIGURED", message: "" }), "对象存储不可用，请确认当前服务实例已配置腾讯云 COS");
  assert.equal(errorModule.voiceSampleUploadFailureMessage({ status: 500, code: "VOICE_SAMPLE_PRESIGN_FAILED", message: "" }), "音频已上传，但生成临时访问地址失败，请稍后重试");
  assert.equal(errorModule.voiceSampleUploadFailureMessage({ status: 0, code: "NETWORK_ERROR", message: "" }), "无法连接声音刻录服务，请检查网络后重试");
});
