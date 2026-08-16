# LiveKit subtitle agent

Joins LiveKit rooms, sends candidate audio to a remote OpenAI-compatible
streaming/batch STT endpoint, and publishes `ai.interviewer.subtitle.v1`
JSON on data topic `subtitle.v1`. It does not talk to the subtitle UI.

Required environment:

- `LIVEKIT_URL`
- `LIVEKIT_API_KEY`
- `LIVEKIT_API_SECRET`

Optional STT (without these the worker still joins so media smoke tests work):

- `STT_BASE_URL`
- `STT_API_KEY`
- `STT_MODEL` (default `whisper-1`)
- `STT_LANGUAGE` (default `zh`)

Do not put keys in git. Compose reads them from `server/deploy/.env`.
