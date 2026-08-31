# LiveKit subtitle agent

Joins LiveKit rooms, subscribes to meeting audio, and is the **only** runtime
that executes ASR, LLM, TTS, or Realtime. Each new room loads the currently
active voice-route snapshot once from control-api; in-progress rooms keep that
snapshot when an administrator switches routes.

## Cascaded mode

Streams 16 kHz mono PCM through the route's ASR → LLM (with versioned session
context) → TTS, publishes PCM back onto a LiveKit audio track, and emits:

- `subtitle.v1` — candidate transcript
- `agent.response.v1` — `{ candidateText, replyText }` for the desktop client

## E2E / Realtime mode

Forwards room PCM into the route's Realtime WebSocket (OpenAI-compatible
Realtime or [阿里云 Qwen-Audio Realtime](https://help.aliyun.com/zh/model-studio/qwen-audio-realtime-user-guides))
and publishes returned audio plus transcripts. Chat Completions is not used
for Qwen Audio Realtime.

## Agent commands

Desktop clients send `agent.command.v1` (`say`, `retry`, `correct`, `report`)
without provider, model, endpoint, or key fields. Results return on
`agent.command.result.v1`. Report generation does not require TTS.

Required environment:

- `LIVEKIT_URL`
- `LIVEKIT_API_KEY`
- `LIVEKIT_API_SECRET`
- `CONTROL_API_ORIGIN` and `AGENT_INTERNAL_TOKEN` (loads
  `GET /api/v1/agent/settings/voice-route`)

A missing or unverified active route fails the room with `VOICE_ROUTE_NOT_READY`;
the worker does not fall back to another route. Logs record route ID, model IDs,
protocol, stage, duration, and error codes — never keys, full transcripts, or
audio.

The Docker build defaults to the official PyPI index. In regions where that is
slow, override the non-secret `PIP_INDEX_URL` build argument with a trusted
package mirror.
