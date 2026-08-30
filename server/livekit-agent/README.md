# LiveKit subtitle agent

Joins LiveKit rooms, subscribes to candidate audio, and publishes meeting subtitles
and (in E2E mode) agent replies over LiveKit data topics.

## Cascaded mode (default)

Streams 16 kHz mono PCM to Alibaba Cloud NLS real-time ASR and publishes
`ai.interviewer.subtitle.v1` JSON on data topic `subtitle.v1`.

## E2E mode

Buffers meeting audio, calls the OpenAI-compatible multimodal `/chat/completions`
endpoint from management **AI settings** (`GET /api/v1/agent/settings/ai`), and
publishes:

- `subtitle.v1` — candidate transcript (`source: livekit-e2e`)
- `agent.response.v1` — `{ candidateText, replyText }` for the desktop client

Required environment:

- `LIVEKIT_URL`
- `LIVEKIT_API_KEY`
- `LIVEKIT_API_SECRET`
- `CONTROL_API_ORIGIN` and `AGENT_INTERNAL_TOKEN` (loads speech/pipeline/ai from control-api)

Cascaded Alibaba Cloud NLS environment:

- `ALIYUN_NLS_APPKEY`
- `ALIYUN_NLS_ACCESS_KEY_ID` and `ALIYUN_NLS_ACCESS_KEY_SECRET`, or `ALIYUN_NLS_TOKEN`
- `ALIYUN_NLS_GATEWAY` (default `https://nls-gateway-cn-shanghai.aliyuncs.com`)
- `STT_LANGUAGE` (default `zh`)

E2E uses management AI settings (Token Plan compatible base URL + API key + audio model).
Configure the pipeline mode to `e2e` in management **语音管线** settings.

The worker fails fast when required configuration is missing. Do not put keys in git.
Compose reads them from `server/deploy/.env`, and logs never include credentials
or transcript contents.

The Docker build defaults to the official PyPI index. In regions where that is
slow, override the non-secret `PIP_INDEX_URL` build argument with a trusted
package mirror.
