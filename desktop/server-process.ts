import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";

import type { OwnedProcess } from "./types";

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
  timeoutMs?: number;
}): Promise<OwnedProcess & { baseUrl: string; child: ChildProcess }> {
  const port = await getAvailableLoopbackPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(options.executablePath, [options.serverPath], {
    cwd: options.cwd,
    env: buildServerEnvironment(port),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  try {
    await waitForHealth(baseUrl, options.timeoutMs ?? 20_000);
    return { owned: true, child, baseUrl };
  } catch (error) {
    child.kill();
    throw error;
  }
}

export async function stopOwnedProcess(processInfo: OwnedProcess | null): Promise<void> {
  if (!processInfo?.owned) return;
  processInfo.child.kill("SIGTERM");
}
