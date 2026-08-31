import json
from dataclasses import dataclass
from typing import Awaitable, Callable

from session_context import SessionContextError, parse_session_context


class AgentCommandError(RuntimeError):
    pass


@dataclass(frozen=True)
class AgentCommand:
    command_id: str
    action: str
    text: str = ""
    answer: str = ""
    expected_revision: int = 0
    context: dict | None = None


def command_requirements(action: str) -> set[str]:
    if action == "say":
        return {"speak"}
    if action in {"retry", "correct"}:
        return {"generate", "speak"}
    if action == "report":
        return {"generate"}
    raise AgentCommandError("AGENT_COMMAND_INVALID")


def parse_agent_command(data: bytes) -> AgentCommand:
    try:
        payload = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise AgentCommandError("AGENT_COMMAND_INVALID") from exc
    allowed = {"v", "id", "action", "text", "answer", "expectedRevision", "context"}
    if not isinstance(payload, dict) or set(payload) - allowed or payload.get("v") != 1:
        raise AgentCommandError("AGENT_COMMAND_INVALID")
    command_id = str(payload.get("id") or "").strip()
    action = str(payload.get("action") or "").strip()
    if not command_id or len(command_id) > 128 or action not in {"say", "retry", "correct", "report"}:
        raise AgentCommandError("AGENT_COMMAND_INVALID")
    text = str(payload.get("text") or "").strip()
    answer = str(payload.get("answer") or "").strip()
    revision = payload.get("expectedRevision", 0)
    if not isinstance(revision, int) or revision < 0 or len(text) > 500 or len(answer) > 4000:
        raise AgentCommandError("AGENT_COMMAND_INVALID")
    if action == "say" and not text or action == "correct" and not answer:
        raise AgentCommandError("AGENT_COMMAND_INVALID")
    context = None
    if payload.get("context") is not None:
        try:
            context = parse_session_context(json.dumps(payload["context"], ensure_ascii=False).encode())
        except SessionContextError as exc:
            raise AgentCommandError("AGENT_COMMAND_INVALID") from exc
    return AgentCommand(command_id, action, text, answer, revision, context)


def result_packet(command_id: str, action: str, result: dict, error: str = "") -> bytes:
    return json.dumps({"v": 1, "commandId": command_id, "action": action, "ok": not error, "result": result, "error": error}, ensure_ascii=False).encode()


def _string_list(value: object, limit: int = 10) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item.strip()[:300] for item in value[:limit] if isinstance(item, str) and item.strip()]


def normalize_report(value: object, fallback: str) -> dict:
    payload = value if isinstance(value, dict) else {}
    summary = payload.get("summary")
    summary = summary.strip()[:2000] if isinstance(summary, str) and summary.strip() else fallback.strip()[:2000]
    evidence = []
    raw_evidence = payload.get("evidence")
    if isinstance(raw_evidence, list):
        for item in raw_evidence[:12]:
            if not isinstance(item, dict):
                continue
            topic = item.get("topic")
            observation = item.get("observation")
            if not isinstance(topic, str) or not topic.strip() or not isinstance(observation, str) or not observation.strip():
                continue
            evidence.append({
                "topic": topic.strip()[:100],
                "observation": observation.strip()[:500],
                "quotes": [quote[:300] for quote in _string_list(item.get("quotes"), 5)],
            })
    return {
        "summary": summary or "暂无可用纪要",
        "strengths": _string_list(payload.get("strengths")),
        "followUps": _string_list(payload.get("followUps")),
        "limitations": _string_list(payload.get("limitations")),
        "evidence": evidence,
    }


async def execute_agent_command(
    command: AgentCommand,
    context: dict,
    generate: Callable[[str, dict], Awaitable[str]],
    speak: Callable[[str], Awaitable[None]],
) -> dict:
    active_context = command.context or context
    if command.action == "say":
        await speak(command.text)
        return {"text": command.text}
    if command.action == "retry":
        text = await generate("根据对话历史重新生成上一条回复，只输出新的回复。", active_context)
        await speak(text)
        return {"question": text, "expectedRevision": command.expected_revision}
    if command.action == "correct":
        text = await generate(f"用户修正了最近回答：{command.answer}\n请生成下一句回复。", active_context)
        await speak(text)
        return {"answer": command.answer, "question": text, "expectedRevision": command.expected_revision}
    report_text = await generate("根据完整对话生成纪要，只输出 JSON：summary 字符串，strengths、followUps、limitations 数组，evidence 数组。", active_context)
    try:
        parsed_report = json.loads(report_text)
    except json.JSONDecodeError:
        parsed_report = {}
    return {"report": normalize_report(parsed_report, report_text)}
