import type { InterviewSession } from "./interview";
import { roleLabel, transcriptSpeakerLabel } from "./assistant-role";

export function safeFilenamePart(value: string) {
  return value.trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "") || "session";
}

function escapeMarkdown(value: string) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/([`*_{}[\]()#+.!|>~-])/g, "\\$1")
    .replace(/\r?\n/g, "  \n");
}

function valueOrUnknown(value: string) {
  return escapeMarkdown(value.trim() || "未填写");
}

function listSection(title: string, items: string[]) {
  return [
    `## ${title}`,
    "",
    ...(items.length > 0
      ? items.map((item) => `- ${escapeMarkdown(item)}`)
      : ["暂无。"]),
    ""
  ];
}

export function renderInterviewMarkdown(session: InterviewSession) {
  const lines = [
    "# 互动记录",
    "",
    `- 互动对象：${valueOrUnknown(session.candidateName)}`,
    `- 对话主题：${valueOrUnknown(session.roleName)}`,
    `- 助手角色：${escapeMarkdown(roleLabel(session.assistantRole))}`,
    `- 开始时间：${valueOrUnknown(session.startedAt || "")}`,
    `- 结束时间：${valueOrUnknown(session.finishedAt || "")}`,
    `- 会话状态：${escapeMarkdown(session.status)}`,
    `- 人工复核：必须`,
    "",
    "## 会话配置",
    "",
    `- 补充说明：${valueOrUnknown(session.jobDescription)}`,
    `- 对话重点：${valueOrUnknown(session.interviewFocus)}`,
    "",
    "## 对话原文",
    ""
  ];

  if (session.transcript.length === 0) {
    lines.push("暂无对话。", "");
  } else {
    session.transcript.forEach((item, index) => {
      lines.push(
        `### ${index + 1}. ${transcriptSpeakerLabel(session.assistantRole, item.role)}`,
        "",
        `时间：${escapeMarkdown(item.at)}`,
        "",
        escapeMarkdown(item.text),
        ""
      );
    });
  }

  lines.push("## AI 互动纪要", "");
  if (!session.report) {
    lines.push("尚未生成互动纪要。", "");
  } else {
    lines.push(
      escapeMarkdown(session.report.summary),
      "",
      ...listSection("明确表现", session.report.strengths),
      ...listSection("建议人工追核", session.report.followUps),
      ...listSection("信息限制", session.report.limitations),
      "## 证据记录",
      ""
    );
    if (session.report.evidence.length === 0) {
      lines.push("暂无可核验证据。", "");
    } else {
      for (const evidence of session.report.evidence) {
        lines.push(
          `### ${escapeMarkdown(evidence.topic)}`,
          "",
          escapeMarkdown(evidence.observation),
          ""
        );
        for (const quote of evidence.quotes) {
          lines.push(`> ${escapeMarkdown(quote)}`, "");
        }
      }
    }
  }

  lines.push(
    "---",
    "",
    "本记录由 AI 辅助整理，不包含录用、淘汰或其他自动决策建议。使用者必须结合场景标准和对话原文进行人工复核。",
    ""
  );
  return lines.join("\n");
}

export function interviewExportFilename(
  session: Pick<InterviewSession, "candidateName" | "roleName">,
  extension: "json" | "md"
) {
  return `${safeFilenamePart(session.candidateName)}-${safeFilenamePart(session.roleName)}.${extension}`;
}
