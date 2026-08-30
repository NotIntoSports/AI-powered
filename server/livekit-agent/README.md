# LiveKit subtitle agent

Joins LiveKit rooms, subscribes to candidate audio, streams 16 kHz mono PCM to
Alibaba Cloud NLS real-time ASR, and publishes `ai.interviewer.subtitle.v1`
JSON on data topic `subtitle.v1`. It does not talk to the subtitle UI.

Required environment:

- `LIVEKIT_URL`
- `LIVEKIT_API_KEY`
- `LIVEKIT_API_SECRET`
- `CONTROL_API_ORIGIN` and `AGENT_INTERNAL_TOKEN` (preferred; loads speech/pipeline from control-api)

Required Alibaba Cloud NLS environment:

- `ALIYUN_NLS_APPKEY`
- `ALIYUN_NLS_ACCESS_KEY_ID` and `ALIYUN_NLS_ACCESS_KEY_SECRET`, or `ALIYUN_NLS_TOKEN`
- `ALIYUN_NLS_GATEWAY` (default `https://nls-gateway-cn-shanghai.aliyuncs.com`)
- `STT_LANGUAGE` (default `zh`)

The worker fails fast when ASR configuration is missing. Do not put keys in git.
Compose reads them from `server/deploy/.env`, and logs never include credentials
or transcript contents.

The Docker build defaults to the official PyPI index. In regions where that is
slow, override the non-secret `PIP_INDEX_URL` build argument with a trusted
package mirror.
