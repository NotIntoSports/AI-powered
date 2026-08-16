import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const toolsBin = join(dirname(fileURLToPath(import.meta.url)), "../.tools/bin");

function run(command, args) {
  return spawnSync(command, args, { encoding: "utf8", windowsHide: true });
}

function dockerLiveKitURL(url) {
  return url
    .replace("127.0.0.1", "host.docker.internal")
    .replace("localhost", "host.docker.internal");
}

function lkBinary() {
  const local = join(toolsBin, process.platform === "win32" ? "lk.exe" : "lk");
  if (existsSync(local)) return local;
  const which = run(process.platform === "win32" ? "where" : "which", ["lk"]);
  if (which.status === 0) return "lk";
  return "";
}

export function runLiveKitAudioLoad({
  url,
  apiKey,
  apiSecret,
  publishers,
  duration
}) {
  const loadArgs = [
    "load-test",
    "--url", url,
    "--api-key", apiKey,
    "--api-secret", apiSecret,
    "--audio-publishers", String(publishers),
    "--subscribers", "0",
    "--duration", duration
  ];
  const lk = lkBinary();
  if (lk) {
    return { result: run(lk, loadArgs), via: lk === "lk" ? "lk" : "tools" };
  }

  const dockerURL = dockerLiveKitURL(url);
  const dockerLoadArgs = loadArgs.map((value) => value === url ? dockerURL : value);
  const dockerBase = ["run", "--rm"];
  if (process.platform === "win32" || process.platform === "darwin") {
    dockerBase.push("--add-host=host.docker.internal:host-gateway");
  } else {
    dockerBase.push("--network", "host");
  }

  let result = run("docker", [...dockerBase, "livekit/livekit-cli:latest", ...dockerLoadArgs]);
  if (result.status === 0) return { result, via: "docker" };
  result = run("docker", [...dockerBase, "livekit/livekit-cli:latest", "lk", ...dockerLoadArgs]);
  return { result, via: "docker" };
}
