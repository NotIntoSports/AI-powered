FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt .
ARG PIP_INDEX_URL=https://pypi.org/simple
RUN pip install --no-cache-dir --index-url "$PIP_INDEX_URL" -r requirements.txt
COPY agent.py aliyun_nls.py ./

ENV PYTHONUNBUFFERED=1
CMD ["python", "agent.py", "start"]
