import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";

const root = process.cwd();
const executable = process.env.AI_INTERVIEWER_RUNTIME_EXECUTABLE
  ?? path.join(root, "dist", "win-unpacked", "AI-Digital-Human.exe");
const runtimeRoot = process.env.AI_INTERVIEWER_RUNTIME_ROOT
  ?? path.join(root, "dist", "win-unpacked", "resources", ".desktop-runtime");
const serverPath = path.join(runtimeRoot, "server.js");

const port = await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    if (!address || typeof address === "string") {
      probe.close();
      reject(new Error("Unable to allocate a packaged runtime test port"));
      return;
    }
    probe.close((error) => error ? reject(error) : resolve(address.port));
  });
});

const child = spawn(executable, [serverPath], {
  cwd: runtimeRoot,
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    HOSTNAME: "127.0.0.1",
    PORT: String(port),
    AI_INTERVIEW_BASE_URL: `http://127.0.0.1:${port}`
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true
});

let diagnostics = "";
child.stdout.on("data", (chunk) => { diagnostics += String(chunk); });
child.stderr.on("data", (chunk) => { diagnostics += String(chunk); });

try {
  const deadline = Date.now() + 20_000;
  let healthy = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) {
        healthy = true;
        break;
      }
    } catch {
      // The packaged standalone server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (!healthy) {
    throw new Error(`Packaged runtime did not become healthy.\n${diagnostics.slice(-4_000)}`);
  }
  process.stdout.write(`Packaged runtime healthy on 127.0.0.1:${port}\n`);
} finally {
  child.kill();
}
