import { renderRoleTemplate, type RoleProfile } from "../../lib/assistant-role.ts";

export function buildOpeningMessage(input: {
  candidateName: string;
  roleName: string;
  consentConfirmed: boolean;
  roleProfile: RoleProfile;
}) {
  const greeting = renderRoleTemplate(input.roleProfile.openingTemplate, {
    target: input.candidateName || "你好",
    topic: input.roleName || "本次交流"
  });
  const disclosure = input.consentConfirmed
    ? " 本次由 AI 虚拟助手协助进行，对话记录会保存并由人工复核。"
    : "";
  return `${greeting}${disclosure}`;
}
