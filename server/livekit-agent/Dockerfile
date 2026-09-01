FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt .
ARG PIP_INDEX_URL=https://pypi.org/simple
RUN pip install --no-cache-dir --index-url "$PIP_INDEX_URL" -r requirements.txt
COPY agent.py aliyun_nls.py e2e_model.py audio_track.py cascade_model.py voice_route.py session_context.py agent_command.py agent_mode.py openai_realtime.py ./

ENV PYTHONUNBUFFERED=1
CMD ["python", "agent.py", "start"]
