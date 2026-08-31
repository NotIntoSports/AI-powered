import json


class SessionContextError(RuntimeError):
    pass


def parse_session_context(data: bytes) -> dict:
    try:
        payload = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SessionContextError("SESSION_CONTEXT_INVALID") from exc
    if not isinstance(payload, dict) or set(payload) - {"v", "role", "topic", "history", "resumeIds"} or payload.get("v") != 1:
        raise SessionContextError("SESSION_CONTEXT_INVALID")
    history = payload.get("history")
    resume_ids = payload.get("resumeIds")
    if not isinstance(history, list) or len(history) > 20 or not isinstance(resume_ids, list) or len(resume_ids) > 20:
        raise SessionContextError("SESSION_CONTEXT_INVALID")
    clean_history = []
    for item in history:
        if not isinstance(item, dict) or set(item) - {"role", "text"}:
            raise SessionContextError("SESSION_CONTEXT_INVALID")
        clean_history.append({"role": str(item.get("role") or "user")[:30], "text": str(item.get("text") or "")[:4000]})
    return {
        "v": 1,
        "role": str(payload.get("role") or "assistant")[:50],
        "topic": str(payload.get("topic") or "")[:500],
        "history": clean_history,
        "resumeIds": [str(value)[:64] for value in resume_ids],
    }
