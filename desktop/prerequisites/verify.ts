import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { spawnSync } from "node:child_process";

export async function sha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export async function verifyArtifact(filePath: string, expectedSha256: string): Promise<boolean> {
  return (await sha256(filePath)).toLowerCase() === expectedSha256.toLowerCase();
}

export function verifyWindowsSignature(filePath: string, publisherPattern: string): boolean {
  if (process.platform !== "win32") return false;
  const script = "$s=Get-AuthenticodeSignature -LiteralPath $args[0]; [pscustomobject]@{Status=[string]$s.Status;Subject=[string]$s.SignerCertificate.Subject}|ConvertTo-Json -Compress";
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script, filePath], {
    encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024
  });
  if (result.status !== 0) return false;
  try {
    const signature = JSON.parse(result.stdout) as { Status: string; Subject: string };
    return signature.Status === "Valid" && signature.Subject.includes(publisherPattern);
  } catch { return false; }
}
