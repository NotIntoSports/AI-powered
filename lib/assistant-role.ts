import { z } from "zod";

export const assistantRoleIds = ["hr", "meeting_assistant", "interviewer", "candidate"] as const;
export const assistantRoleSchema = z.enum(assistantRoleIds);
export type AssistantRole = z.infer<typeof assistantRoleSchema>;

export type RoleProfile = {
  role: AssistantRole;
  label: string;
  openingTemplate: string;
  closingTemplate: string;
  instructions: string;
  configVersion: number;
  updatedAt: string | null;
};

export const builtInRoleProfiles: Record<AssistantRole, RoleProfile> = {
  hr: {
    role: "hr", label: "HR",
    openingTemplate: "{{target}}，你好。我们将围绕「{{topic}}」进行招聘初步沟通。请先简单介绍一下你的相关经历。",
    closingTemplate: "感谢你参与「{{topic}}」的沟通。本次初步交流到这里，后续招聘流程会另行通知。",
    instructions: "你是 HR，只围绕招聘初筛、岗位意向、相关经历和流程沟通；每轮只问一个招聘相关问题。",
    configVersion: 0, updatedAt: null
  },
  meeting_assistant: {
    role: "meeting_assistant", label: "会议助手",
    openingTemplate: "{{target}}，你好。现在开始「{{topic}}」会议，我会协助梳理议题、结论和行动项。请先说明当前最需要推进的事项。",
    closingTemplate: "「{{topic}}」会议到这里。我会以本次对话中的结论和行动项为准整理记录。",
    instructions: "你是会议助手，只围绕议题澄清、进度推进、结论和行动项；先简短归纳，最多提出一个推进问题。",
    configVersion: 0, updatedAt: null
  },
  interviewer: {
    role: "interviewer", label: "面试官",
    openingTemplate: "{{target}}，你好。现在开始关于「{{topic}}」的面试。请先介绍与本主题最相关的一段经历。",
    closingTemplate: "感谢你参加「{{topic}}」面试，本次交流到这里。如有后续安排，相关人员会再与你联系。",
    instructions: "你是面试官，只围绕岗位能力、实际经历、个人贡献、取舍和结果；每轮只问一个具体问题。",
    configVersion: 0, updatedAt: null
  },
  candidate: {
    role: "candidate", label: "应聘者",
    openingTemplate: "您好，我是{{target}}。接下来我会围绕「{{topic}}」回答您的问题。",
    closingTemplate: "感谢您的交流。关于「{{topic}}」的面试回答到这里。",
    instructions: "你是应聘者，把对方字幕视为面试官问题，以第一人称直接回答，不反向主持面试；资料不足时给出不含虚构公司、项目和数字的通用示范答案。",
    configVersion: 0, updatedAt: null
  }
};

const placeholderPattern = /{{\s*([^{}]+?)\s*}}/g;
export function validateRoleTemplate(template: string) {
  if (!template.trim() || template.length > 500) return false;
  if (![...template.matchAll(placeholderPattern)].every((match) => match[1] === "target" || match[1] === "topic")) return false;
  return !template.replace(placeholderPattern, "").includes("{{") && !template.replace(placeholderPattern, "").includes("}}");
}

export function renderRoleTemplate(template: string, values: { target: string; topic: string }) {
  if (!validateRoleTemplate(template)) throw new Error("INVALID_ROLE_TEMPLATE");
  return template.replace(placeholderPattern, (_, key: string) => key === "target" ? values.target : values.topic);
}

export function roleLabel(role: AssistantRole) {
  return builtInRoleProfiles[role].label;
}

export function transcriptSpeakerLabel(role: AssistantRole, speaker: "interviewer" | "candidate") {
  if (speaker === "interviewer") return roleLabel(role);
  return role === "candidate" ? "面试官" : "对方";
}

export function roleFallback(role: AssistantRole) {
  if (role === "candidate") return "我会结合与这个主题相关的实际经历来回答。若当前资料不足，我会说明自己的思路和处理方法，不虚构具体公司、项目或数字。";
  if (role === "meeting_assistant") return "目前信息还不完整。为了推进议题，下一步最需要确认的事项是什么？";
  if (role === "hr") return "请介绍一段与这个岗位最相关的经历，以及你在其中承担的职责。";
  return "请具体介绍一段与这个主题相关的实际经历，以及你在其中承担的职责。";
}
