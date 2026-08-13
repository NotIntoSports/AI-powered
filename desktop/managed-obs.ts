import { randomBytes } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import net from "node:net";
import { OBSWebSocket } from "obs-websocket-js";

import { detectManagedObs, listExternalObsProcesses, managedObsExecutable, startOwnedObs } from "./obs-process";
import type { ManagedObsState, OwnedProcess } from "./types";

const PORT = 4455;
const MAX_ATTEMPTS = 5;
const CONFIG_VERSION = 1;

function wait(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function canConnect(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const done = (value: boolean) => { socket.destroy(); resolve(value); };
    socket.setTimeout(750);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

export class ManagedObsController {
  private process: OwnedProcess | null = null;
  private password = "";
  private client: OBSWebSocket | null = null;
  private running: Promise<ManagedObsState> | null = null;

  constructor(private readonly templateRoot: string, private readonly runtimeRoot: string, private readonly stageUrl: string) {}

  async ensure(): Promise<ManagedObsState> {
    if (this.running) return this.running;
    this.running = this.start().finally(() => { this.running = null; });
    return this.running;
  }

  private async prepareRuntime() {
    const marker = path.join(this.runtimeRoot, ".managed-version.json");
    let version = 0;
    try { version = JSON.parse(await readFile(marker, "utf8")).version; } catch { /* first run */ }
    if (version !== CONFIG_VERSION || !existsSync(managedObsExecutable(this.runtimeRoot))) {
      await rm(this.runtimeRoot, { recursive: true, force: true });
      await mkdir(path.dirname(this.runtimeRoot), { recursive: true });
      await cp(this.templateRoot, this.runtimeRoot, { recursive: true });
      await writeFile(path.join(this.runtimeRoot, "portable_mode.txt"), "", "utf8");
      await writeFile(marker, JSON.stringify({ version: CONFIG_VERSION }), "utf8");
    }
  }

  private async start(): Promise<ManagedObsState> {
    if (!existsSync(managedObsExecutable(this.templateRoot))) return { status: "not-installed" };
    await this.prepareRuntime();
    const external = listExternalObsProcesses(managedObsExecutable(this.runtimeRoot));
    if (external.length) return { status: "blocked-by-external-obs", processes: external };
    const installation = detectManagedObs(this.runtimeRoot);
    if (!installation) return { status: "not-installed" };
    if (!this.process) {
      this.password = randomBytes(32).toString("base64url");
      try { this.process = startOwnedObs(installation, this.password, PORT); }
      catch { return { status: "failed", stage: "process", code: "OBS_SPAWN_FAILED" }; }
    }
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (await canConnect(PORT)) {
        const ready = await this.authenticateAndConfigure();
        if (ready.status === "ready") return ready;
        if (ready.stage !== "auth") return ready;
      }
      if (attempt < MAX_ATTEMPTS) await wait(1_500);
    }
    return { status: "failed", stage: "port", code: "OBS_PORT_NOT_READY" };
  }

  private async authenticateAndConfigure(): Promise<Extract<ManagedObsState, { status: "ready" | "failed" }>> {
    const client = new OBSWebSocket();
    try { await client.connect(`ws://127.0.0.1:${PORT}`, this.password, { rpcVersion: 1 }); }
    catch { return { status: "failed", stage: "auth", code: "OBS_AUTH_FAILED" }; }
    this.client = client;
    try {
      const sceneName = "AI Digital Human";
      const inputName = "AI Digital Human Stage";
      const scenes = await client.call("GetSceneList") as { scenes?: Array<{ sceneName?: string }> };
      if (!scenes.scenes?.some((scene) => scene.sceneName === sceneName)) await client.call("CreateScene", { sceneName });
      const inputs = await client.call("GetInputList", { inputKind: "browser_source" }) as { inputs?: Array<{ inputName?: string }> };
      if (!inputs.inputs?.some((input) => input.inputName === inputName)) {
        await client.call("CreateInput", { sceneName, inputName, inputKind: "browser_source", inputSettings: { url: this.stageUrl, width: 1280, height: 720, fps: 30, reroute_audio: true }, sceneItemEnabled: true });
      } else await client.call("SetInputSettings", { inputName, inputSettings: { url: this.stageUrl }, overlay: true });
      await client.call("SetCurrentProgramScene", { sceneName });
    } catch { return { status: "failed", stage: "scene", code: "OBS_SCENE_CONFIG_FAILED" }; }
    try {
      const status = await client.call("GetVirtualCamStatus") as { outputActive: boolean };
      if (!status.outputActive) await client.call("StartVirtualCam");
      const verified = await client.call("GetVirtualCamStatus") as { outputActive: boolean };
      if (!verified.outputActive) throw new Error("inactive");
    } catch { return { status: "failed", stage: "virtual-camera", code: "OBS_VIRTUAL_CAMERA_FAILED" }; }
    return { status: "ready", port: PORT, virtualCameraActive: true, url: `ws://127.0.0.1:${PORT}`, password: this.password, stageUrl: this.stageUrl };
  }

  async reset(): Promise<ManagedObsState> {
    await this.stop();
    await rm(this.runtimeRoot, { recursive: true, force: true });
    return this.ensure();
  }

  async stop() {
    if (this.client) {
      try { await this.client.call("StopVirtualCam"); } catch { /* already stopped */ }
      try { await this.client.disconnect(); } catch { /* ignore */ }
      this.client = null;
      await wait(1_000);
    }
    this.process?.child.kill();
    this.process = null;
    this.password = "";
  }
}
