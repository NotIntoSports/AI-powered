export function buildOpeningMessage(input: {
  candidateName: string;
  roleName: string;
  consentConfirmed: boolean;
}) {
  const greeting = `${input.candidateName || "你好"}，欢迎开始关于「${input.roleName || "本次交流"}」的互动。`;
  const disclosure = input.consentConfirmed
    ? "本次由 AI虚拟助手协助进行，对话记录会保存并由人工复核。"
    : "";
  return `${greeting}${disclosure}请先用两分钟介绍一下你自己。`;
}
