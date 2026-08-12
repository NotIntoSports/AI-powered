import { spawn, type ChildProcess } from "node:child_process";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import type { OwnedProcess } from "./types";

const MAX_DIAGNOSTIC_LENGTH = 2_000;

export class LocalServerStartError extends Error {
  readonly logPath: string;

  constructor(message: string, logPath: string) {
    super(message);
    this.name = "LocalServerStartError";
    this.logPath = logPath;
  }
}

export function sanitizeServerOutput(value: string): string {
  return value
    .replace(/(Authorization\s*:\s*Bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/\b(API[_-]?KEY|TOKEN|SECRET|PASSWORD)\s*([:=])\s*[^\s]+/gi, "$1$2[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@");
}

export function getAvailableLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Unable to allocate a loopback port"));
        return;
      }
      const { port } = address;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

export function buildServerEnvironment(
  port: number,
  inherited: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  return {
    ...inherited,
    ELECTRON_RUN_AS_NODE: "1",
    HOSTNAME: "127.0.0.1",
    PORT: String(port),
    AI_INTERVIEW_BASE_URL: `http://127.0.0.1:${port}`
  };
}

async function waitForHealth(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // The standalone server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Local service did not become healthy within ${timeoutMs}ms`);
}

export async function startLocalServer(options: {
  executablePath: string;
  serverPath: string;
  cwd: string;
  logPath?: string;
  timeoutMs?: number;
}): Promise<OwnedProcess & { baseUrl: string; child: ChildProcess }> {
  const port = await getAvailableLoopbackPort();
  const baseUrl = `http://127.0.0.1:${port}`;

  if (options.logPath) {
    await mkdir(path.dirname(options.logPath), { recursive: true });
    await writeFile(options.logPath, "", "utf8");
  }

  const child = spawn(options.executablePath, [options.serverPath], {
    cwd: options.cwd,
    env: buildServerEnvironment(port),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });

  let diagnostics = "";
  let pendingLogWrite = Promise.resolve();
  const recordOutput = (chunk: Buffer | string) => {
    const sanitized = sanitizeServerOutput(String(chunk));
    diagnostics = `${diagnostics}${sanitized}`.slice(-MAX_DIAGNOSTIC_LENGTH);
    if (options.logPath) {
      pendingLogWrite = pendingLogWrite.then(() => appendFile(options.logPath!, sanitized, "utf8"));
    }
  };
  child.stdout?.on("data", recordOutput);
  child.stderr?.on("data", recordOutput);

  const exited = new Promise<never>((_resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      reject(new Error(`Local service exited before becoming healthy (code ${code ?? "none"}, signal ${signal ?? "none"})`));
    });
  });
  try {
    await Promise.race([waitForHealth(baseUrl, options.timeoutMs ?? 20_000), exited]);
    return { owned: true, child, baseUrl };
  } catch (error) {
    child.kill();
    await pendingLogWrite.catch(() => undefined);
    const detail = diagnostics.trim() || (error instanceof Error ? error.message : String(error));
    throw new LocalServerStartError(
      `Local service failed to start: ${detail}`,
      options.logPath ?? "not configured"
    );
  }
}

export async function stopOwnedProcess(processInfo: OwnedProcess | null): Promise<void> {
  if (!processInfo?.owned) return;
  processInfo.child.kill("SIGTERM");
}
