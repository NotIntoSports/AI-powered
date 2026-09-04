import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const LOCAL_ENV_PREFIXES = [
  "CONTROL_API_",
  "SPEECH_",
  "ALIYUN_",
  "VOLCENGINE_"
];

function shouldImportKey(key: string) {
  return LOCAL_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** Merge selected keys from a dotenv file into process.env without overwriting non-empty values. */
export function applyLocalEnvFile(filePath: string, env: NodeJS.ProcessEnv = process.env): number {
  if (!existsSync(filePath)) return 0;
  const text = readFileSync(filePath, "utf8");
  let applied = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const matched = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!matched) continue;
    const key = matched[1];
    if (!shouldImportKey(key)) continue;
    let value = matched[2].trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if ((env[key] || "").trim()) continue;
    env[key] = value;
    applied += 1;
  }
  return applied;
}

export function resolveDesktopEnvFiles(cwd = process.cwd()): string[] {
  return [
    path.join(cwd, ".env.local"),
    path.join(cwd, ".env")
  ];
}
