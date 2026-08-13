import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import { OBSWebSocket } from "obs-websocket-js";

const root = process.cwd();
const executable = process.env.AI_INTERVIEWER_RUNTIME_EXECUTABLE
  ?? path.join(root, "dist", "win-unpacked", "AI-Digital-Human.exe");
const runtimeRoot = process.env.AI_INTERVIEWER_RUNTIME_ROOT
  ?? path.join(root, "dist", "win-unpacked", "resources", ".desktop-runtime");
const serverPath = path.join(runtimeRoot, "server.js");
const obsSmokeMode = process.env.AI_INTERVIEWER_PACKAGED_OBS_SMOKE ?? "skip";

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitForObs(client, password, deadline) {
  let lastError;
  while (Date.now() < deadline) {
    try {
      const identified = await client.connect("ws://127.0.0.1:4455", password, { rpcVersion: 1 });
      return identified;
    } catch (error) {
      lastError = error;
      await wait(250);
    }
  }
  throw new Error(`Packaged OBS did not accept an authenticated connection: ${lastError instanceof Error ? lastError.message : "timeout"}`);
}

async function runPackagedObsSmoke(stageUrl) {
  if (process.platform !== "win32") throw new Error("Real packaged OBS smoke mode requires Windows");
  const templateRoot = process.env.AI_INTERVIEWER_PACKAGED_OBS_ROOT
    ?? path.join(root, "dist", "win-unpacked", "resources", "prerequisites", "obs-portable");
  const templateExecutable = path.join(templateRoot, "bin", "64bit", "obs64.exe");
  const scratch = await mkdtemp(path.join(tmpdir(), "ai-interviewer-packaged-obs-"));
  const runtime = path.join(scratch, "obs");
  const executable = path.join(runtime, "bin", "64bit", "obs64.exe");
  const configDirectory = path.join(runtime, "config", "obs-studio", "plugin_config", "obs-websocket");
  const password = randomBytes(32).toString("base64url");
  const client = new OBSWebSocket();
  let obs;
  try {
    if (!(await stat(templateExecutable).catch(() => null))?.isFile()) {
      throw new Error(`Packaged OBS executable is missing: ${templateExecutable}`);
    }
    await mkdir(runtime, { recursive: true });
    // A junction keeps this opt-in smoke fast while still giving OBS a clean,
    // disposable portable configuration root. It never modifies the package.
    await symlink(path.join(templateRoot, "bin"), path.join(runtime, "bin"), "junction");
    for (const directory of ["data", "obs-plugins"]) {
      await symlink(path.join(templateRoot, directory), path.join(runtime, directory), "junction");
    }
    await writeFile(path.join(runtime, "portable_mode.txt"), "", "utf8");
    await mkdir(configDirectory, { recursive: true });
    await writeFile(path.join(configDirectory, "config.json"), JSON.stringify({
      alerts_enabled: false,
      auth_required: true,
      first_load: false,
      server_enabled: true,
      server_password: password,
      server_port: 4455
    }), { encoding: "utf8", mode: 0o600 });
    await chmod(path.join(configDirectory, "config.json"), 0o600).catch(() => {});

    const obsArgs = [
      "--portable", "--multi", "--only-bundled-plugins", "--disable-updater",
      "--disable-missing-files-check", "--minimize-to-tray", "--websocket_ipv4_only"
    ];
    if (obsArgs.some((argument) => /password/i.test(argument))) {
      throw new Error("Packaged OBS smoke refused to expose a password through argv");
    }
    obs = spawn(executable, obsArgs, { cwd: path.dirname(executable), stdio: "ignore", windowsHide: true });
    const identified = await waitForObs(client, password, Date.now() + 30_000);
    const version = await client.call("GetVersion");
    const sceneName = `Packaged Smoke ${createHash("sha256").update(scratch).digest("hex").slice(0, 8)}`;
    const inputName = `${sceneName} Stage`;
    await client.call("CreateScene", { sceneName });
    await client.call("CreateInput", {
      sceneName,
      inputName,
      inputKind: "browser_source",
      inputSettings: { url: stageUrl, width: 1280, height: 720, fps: 30, reroute_audio: true },
      sceneItemEnabled: true
    });
    await client.call("SetInputAudioMonitorType", { inputName, monitorType: "OBS_MONITORING_TYPE_MONITOR_ONLY" });
    await client.call("SetCurrentProgramScene", { sceneName });
    if (obsSmokeMode === "real" || obsSmokeMode === "1") {
      const before = await client.call("GetVirtualCamStatus");
      if (!before.outputActive) await client.call("StartVirtualCam");
      const after = await client.call("GetVirtualCamStatus");
      if (!after.outputActive) throw new Error("Packaged OBS virtual camera did not start");
      await client.call("StopVirtualCam").catch(() => {});
    }
    process.stdout.write(`Packaged OBS ${version.obsVersion ?? identified.obsWebSocketVersion ?? "unknown"} authenticated and configured\n`);
  } finally {
    await client.disconnect().catch(() => {});
    if (obs && obs.exitCode === null) {
      obs.kill();
      await Promise.race([
        new Promise((resolve) => obs.once("exit", resolve)),
        wait(2_000)
      ]);
    }
    for (const directory of ["bin", "data", "obs-plugins"]) {
      await rm(path.join(runtime, directory), { force: true }).catch(() => {});
    }
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

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
  if (obsSmokeMode === "control" || obsSmokeMode === "real" || obsSmokeMode === "1") {
    await runPackagedObsSmoke(`http://127.0.0.1:${port}/stage`);
  } else {
    process.stdout.write("Packaged OBS smoke skipped (set AI_INTERVIEWER_PACKAGED_OBS_SMOKE=control or real to enable)\n");
  }
} finally {
  child.kill();
}
