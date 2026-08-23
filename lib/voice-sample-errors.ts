import type { ControlApiFailure } from "./control-api-result";

export function voiceSampleUploadFailureMessage(failure: ControlApiFailure): string {
  if (failure.status === 401 || failure.status === 403 || failure.code === "AUTH_REQUIRED" || failure.code === "UNAUTHENTICATED") {
    return "登录已过期，请重新登录后再提交刻录";
  }
  if (failure.status === 404) {
    return "声音刻录服务版本未更新，请联系管理员更新服务";
  }
  if (failure.status === 503 || failure.code === "STORAGE_UNCONFIGURED") {
    return "对象存储不可用，请确认当前服务实例已配置腾讯云 COS";
  }
  if (failure.code === "VOICE_SAMPLE_UPLOAD_FAILED") {
    return "音频上传到对象存储失败，请检查 COS 写入权限后重试";
  }
  if (failure.code === "VOICE_SAMPLE_PRESIGN_FAILED") {
    return "音频已上传，但生成临时访问地址失败，请稍后重试";
  }
  if (failure.status === 0 || failure.code === "NETWORK_ERROR") {
    return "无法连接声音刻录服务，请检查网络后重试";
  }
  return "声音刻录上传服务内部错误，请稍后重试";
}
