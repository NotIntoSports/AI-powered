import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runLiveKitAudioLoad } from "./livekit-audio-cli.mjs";

const url = process.env.LIVEKIT_URL || "ws://127.0.0.1:7880";
const apiKey = process.env.LIVEKIT_API_KEY || "devkey";
const apiSecret = process.env.LIVEKIT_API_SECRET || "secret";
const publishers = process.env.LIVEKIT_AUDIO_PUBLISHERS || "10";
const duration = process.env.LIVEKIT_LOAD_DURATION || "15s";
const httpURL = url.replace(/^ws/i, "http");
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const toolsBin = join(repoRoot, ".tools/bin");

async function probe() {
  try {
    const response = await fetch(httpURL, { signal: AbortSignal.timeout(3000) });
    return response.status < 500;
  } catch {
    return false;
  }
}

function localServerBinary() {
  const names = process.platform === "win32"
    ? ["livekit-server.exe", "server.exe"]
    : ["livekit-server", "server"];
  return names.map((name) => join(toolsBin, name)).find((path) => existsSync(path));
}

let started;
if (!(await probe())) {
  const binary = localServerBinary();
  if (binary) {
    started = spawn(binary, ["--dev", "--bind", "0.0.0.0"], {
      cwd: repoRoot,
      windowsHide: true,
      stdio: "ignore"
    });
    for (let attempt = 0; attempt < 20 && !(await probe()); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

try {
  const { result, via } = runLiveKitAudioLoad({
    url,
    apiKey,
    apiSecret,
    publishers,
    duration
  });
  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
  if (result.status !== 0) {
    console.error("Install LiveKit CLI (`lk`) or Docker to run the 10-publisher audio load test.");
    console.error("Example:");
    console.error(`  lk load-test --url ${url} --api-key ${apiKey} --api-secret *** --audio-publishers ${publishers} --subscribers 0 --duration ${duration}`);
    process.exit(result.status ?? 1);
  }
  console.log(`livekit ${publishers}-audio publisher load test finished via ${via}`);
  console.log("Use CPU, memory, bandwidth, and TURN relay share from this run as the threshold to switch activeProvider back to volcengine.");
} finally {
  started?.kill();
}
