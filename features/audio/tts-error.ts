export function describeTtsError(error: string) {
  const normalized = error.trim().toLowerCase();
  if (!normalized) return "语音播放失败，请重新测试。";
  if (/not.?allowed/.test(normalized)) {
    return "浏览器阻止了自动播放。请打开助手舞台，或在 OBS 中右键舞台源选择“交互”，点击“启用声音并重播”。";
  }
  if (/sapi-http-(?:500|503)|sapi_unavailable|sapi_failed/.test(normalized)) {
    return "Windows 本机语音生成失败。请运行环境检查确认中文 SAPI 声音可用，然后重新测试。";
  }
  if (/notfound|not-found|voice-unavailable/.test(normalized)) {
    return "没有找到可用的中文声音。请在 Windows 语言和语音设置中安装中文语音包。";
  }
  if (/audio-capture|notreadable|not-readable/.test(normalized)) {
    return "音频设备当前无法读取，可能正被其他软件独占。请关闭占用设备的软件后重试。";
  }
  if (/network|fetch|timeout/.test(normalized)) {
    return "语音服务连接超时或中断。请确认本地服务仍在运行后重试。";
  }
  return "语音播放失败。请重新测试；若仍失败，请运行 Windows 环境检查。";
}
