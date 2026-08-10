# Windows 客户端使用说明

支持 Windows 10 2004 及以上、Windows 11，x64。安装器包含客户端、AudioBridge sidecar、OBS 官方安装器和签名的 Virtual-Audio-Driver 安装资源；OBS 与驱动只在用户点击安装并通过 UAC 后安装。

## 首次使用

1. 安装并启动客户端，在“客户端安装环境”安装 OBS 和虚拟音频设备。
2. 在模型设置填写 OpenAI-compatible HTTPS 地址、API Key 和模型名。
3. 在 RTC 设置填写火山 App ID、房间、用户 ID，以及 HTTPS Token 服务；内部试用可临时填写短期 Token。客户端不保存 AppKey。
4. 打开 OBS“设置 → 音频 → 高级”，把监听设备选为虚拟音频播放端。会议软件把摄像头选为 `OBS Virtual Camera`，麦克风选为对应虚拟录音端。
5. 客户端选择会议软件进程，启动 RTC 字幕，再完成画面、测试语音和会议入会预览检查。

## 监听和人工介入

候选人声音继续由腾讯会议、飞书、钉钉或 Teams 播放，客户端不重复播放。按住“按住说话”会暂停 AI、静音舞台音频并打开 Windows 默认麦克风；松开后两路都保持静音。点击“恢复 AI”后才继续自动流程。“立即静音全部输出”关闭两路声音。

## 安全和限制

- API Key、RTC Token 和 OBS 密码使用 Windows DPAPI CurrentUser 加密；不要提交 `data/` 或 `.env.local`。
- 原始会议 PCM 默认不落盘。会议音频与字幕会按火山引擎配置发送到其服务；模型文本会发送到用户填写的 API。
- Electron 安装器目前没有企业代码签名证书，Windows 可能显示未知发布者；依赖安装资源会单独验证固定 SHA-256，虚拟音频驱动还验证 Authenticode。
- 全局监听设备不能通过受支持的 obs-websocket 请求自动修改，首次使用必须在 OBS 设置一次。
- 发布前仍需完成真实声卡、真实会议软件和火山生产 Token 服务的验收；当前版本面向少量内部试用者，不应广泛部署。
