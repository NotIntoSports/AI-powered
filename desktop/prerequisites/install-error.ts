import type { PrerequisiteInstallErrorCode } from "../types";

const ERROR_CODE_MAP: Array<[RegExp, PrerequisiteInstallErrorCode]> = [
  [/PREREQUISITE_UAC_CANCELLED/, "uac-cancelled"],
  [/PREREQUISITE_RESOURCE_MISSING/, "resource-missing"],
  [/PREREQUISITE_SIGNATURE_REJECTED/, "signature-rejected"],
  [/PREREQUISITE_MODULE_LOAD_FAILED/, "module-load-failed"],
  [/PREREQUISITE_HASH_MISMATCH/, "hash-mismatch"],
  [/PREREQUISITE_REGISTRATION_FAILED/, "registration-failed"],
  [/PREREQUISITE_INSTALL_FAILED/, "install-failed"],
  [/PREREQUISITE_DOWNLOAD_FAILED/, "download-failed"]
];

export function classifyPrerequisiteInstallError(
  output: string,
  exitCode?: number | null
): { code: PrerequisiteInstallErrorCode; message: string } {
  const compact = output.replace(/\u001b\[[0-9;]*m/g, "").replace(/\s+/g, " ").trim();
  if (!compact) {
    const exit = exitCode == null ? "unknown" : String(exitCode);
    return { code: "unknown", message: `exit ${exit}, empty installer output` };
  }
  const marker = compact.match(/PREREQUISITE_[A-Z_]+/)?.[0];
  const rest = compact.replace(/^(?:PREREQUISITE_[A-Z_]+:\s*)+/, "").trim();
  const normalized = marker ? `${marker}: ${rest}` : compact;
  const code = ERROR_CODE_MAP.find(([pattern]) => pattern.test(normalized))?.[1] ?? "unknown";
  const detail = rest || normalized;
  return { code, message: detail.slice(0, 500) };
}
