import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runLiveKitAudioLoad } from "./livekit-audio-cli.mjs";

const livekitURL = process.env.LIVEKIT_URL || "http://127.0.0.1:7880";
const wsURL = process.env.LIVEKIT_WS_URL || livekitURL.replace(/^http/i, "ws");
const apiKey = process.env.LIVEKIT_API_KEY || "devkey";
const apiSecret = process.env.LIVEKIT_API_SECRET || "secret";
const target = livekitURL.replace(/^ws/i, "http");
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const composeDir = join(repoRoot, "server/control-api");
const toolsBin = join(repoRoot, ".tools/bin");

async function probe(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return { ok: response.status < 500, status: response.status };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "unreachable" };
  }
}

function localServerBinary() {
  const names = process.platform === "win32"
    ? ["livekit-server.exe", "server.exe"]
    : ["livekit-server", "server"];
  return names.map((name) => join(toolsBin, name)).find((path) => existsSync(path));
}

async function waitForLiveKit() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const again = await probe(target);
    if (again.ok) return again;
  }
  return { ok: false };
}

const direct = await probe(target);
let started;
if (!direct.ok) {
  const compose = spawnSync("docker", ["compose", "--profile", "livekit", "up", "-d", "livekit"], {
    cwd: composeDir,
    encoding: "utf8",
    windowsHide: true
  });
  if (compose.status === 0) {
    const ready = await waitForLiveKit();
    if (!ready.ok) {
      console.error("LiveKit container started but HTTP probe still failed.");
      process.exit(1);
    }
    console.log(`livekit started and reachable at ${target} status=${ready.status}`);
  } else {
    const binary = localServerBinary();
    if (!binary) {
      console.error(`LiveKit is not reachable at ${target}. Start it with:`);
      console.error("  docker compose --profile livekit up -d livekit");
      console.error("or place livekit-server in .tools/bin");
      console.error(compose.stderr || direct.error || "");
      process.exit(1);
    }
    started = spawn(binary, ["--dev", "--bind", "0.0.0.0"], {
      cwd: repoRoot,
      windowsHide: true,
      stdio: "ignore"
    });
    const ready = await waitForLiveKit();
    if (!ready.ok) {
      started.kill();
      console.error("Local livekit-server started but HTTP probe still failed.");
      process.exit(1);
    }
    console.log(`livekit-server started from ${binary} at ${target} status=${ready.status}`);
  }
} else {
  console.log(`livekit reachable at ${target} status=${direct.status}`);
}

try {
  const audio = runLiveKitAudioLoad({
    url: wsURL,
    apiKey,
    apiSecret,
    publishers: 1,
    duration: process.env.LIVEKIT_SMOKE_DURATION || "8s"
  });
  process.stdout.write(audio.result.stdout || "");
  process.stderr.write(audio.result.stderr || "");
  if (audio.result.status !== 0) {
    console.error("LiveKit HTTP probe passed, but 1-publisher PCM smoke failed.");
    console.error("Install LiveKit CLI (`lk`) or Docker, then retry npm run test:livekit-smoke.");
    process.exit(audio.result.status ?? 1);
  }
  console.log(`livekit 1-audio publisher smoke passed via ${audio.via}`);
} finally {
  started?.kill();
}
