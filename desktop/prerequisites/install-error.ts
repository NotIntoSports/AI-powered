import type { PrerequisiteInstallErrorCode } from "../types";

const ERROR_CODE_MAP: Array<[RegExp, PrerequisiteInstallErrorCode]> = [
  [/PREREQUISITE_UAC_CANCELLED/, "uac-cancelled"],
  [/PREREQUISITE_RESOURCE_MISSING/, "resource-missing"],
  [/PREREQUISITE_SIGNATURE_REJECTED/, "signature-rejected"],
  [/PREREQUISITE_INSTALL_FAILED/, "install-failed"]
];

export function classifyPrerequisiteInstallError(output: string): { code: PrerequisiteInstallErrorCode; message: string } {
  const compact = output.replace(/\u001b\[[0-9;]*m/g, "").replace(/\s+/g, " ").trim();
  const code = ERROR_CODE_MAP.find(([pattern]) => pattern.test(compact))?.[1] ?? "unknown";
  const detail = compact.match(/PREREQUISITE_[A-Z_]+(?::\s*)?(.+)?/)?.[1]?.trim();
  return { code, message: (detail || "安装进程未提供详细信息").slice(0, 500) };
}
