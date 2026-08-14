import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { OBSWebSocket } from "obs-websocket-js";

import {
  MANAGED_OBS_CONFIG_VERSION,
  MANAGED_OBS_PORT,
  writeManagedObsWebSocketConfiguration
} from "./obs-config";
import {
  detectManagedObs,
  listExternalObsProcesses,
  listManagedObsProcesses,
  managedObsExecutable,
  startOwnedObs,
  type ManagedObsOwnedProcess
} from "./obs-process";
import {
  configureManagedObsScene,
  setManagedObsInterventionRouting,
  type InterventionAction
} from "./obs-scene";
import { ManagedObsSecretError, type ManagedObsSecretStore } from "./obs-secret-store";
import type { ManagedObsState } from "./types";
import { reconcileVirtualCameraState } from "./virtual-camera-state";

export const MANAGED_OBS_STARTUP_TIMEOUT_MS = 30_000;
const PORT_POLL_INTERVAL_MS = 500;
const PROCESS_STOP_TIMEOUT_MS = 5_000;
const MAX_STARTUP_ATTEMPTS = Math.ceil(MANAGED_OBS_STARTUP_TIMEOUT_MS / PORT_POLL_INTERVAL_MS);

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function canConnectToManagedObs(port = MANAGED_OBS_PORT): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const done = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(500);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

export async function prepareManagedObsRuntime(
  templateRoot: string,
  runtimeRoot: string,
  password: string
): Promise<void> {
  const marker = path.join(runtimeRoot, ".managed-version.json");
  let version = 0;
  try {
    version = (JSON.parse(await readFile(marker, "utf8")) as { version?: number }).version ?? 0;
  } catch {
    // A missing or malformed marker is a first run and must be rebuilt from the signed template.
  }

  if (version !== MANAGED_OBS_CONFIG_VERSION || !existsSync(managedObsExecutable(runtimeRoot))) {
    await rm(runtimeRoot, { recursive: true, force: true });
    await mkdir(path.dirname(runtimeRoot), { recursive: true });
    await cp(templateRoot, runtimeRoot, { recursive: true });
    await writeFile(path.join(runtimeRoot, "portable_mode.txt"), "", "utf8");
    await writeFile(marker, `${JSON.stringify({ version: MANAGED_OBS_CONFIG_VERSION })}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
  }

  // Always restore the controlled settings before launch. This also repairs a user toggling
  // the portable plugin off without exposing the credential through process arguments.
  await writeManagedObsWebSocketConfiguration(runtimeRoot, password);
}

export interface ManagedObsControllerOptions {
  templateRoot: string;
  runtimeRoot: string;
  stageUrl: string;
  secretStore: ManagedObsSecretStore;
  packagedVersion?: string;
  isVirtualCameraRegistered?: () => boolean | Promise<boolean>;
}

export class ManagedObsController {
  private process: ManagedObsOwnedProcess | null = null;
  private client: OBSWebSocket | null = null;
  private password: string | null = null;
  private running: Promise<ManagedObsState> | null = null;
  private state: ManagedObsState = { status: "idle" };
  private generation = 0;
  private reconciledStaleProcess = false;
  private obsVersion: string;

  constructor(private readonly options: ManagedObsControllerOptions) {
    this.obsVersion = options.packagedVersion ?? "32.2.1";
  }

  getStateSnapshot(): ManagedObsState {
    return this.state;
  }

  async getState(): Promise<ManagedObsState> {
    if (!this.client || this.state.status !== "ready") return this.state;
    try {
      const status = await this.client.call("GetVirtualCamStatus") as { outputActive: boolean };
      this.state = {
        status: "ready",
        version: this.obsVersion,
        virtualCameraActive: status.outputActive
      };
    } catch {
      this.client = null;
      this.state = { status: "failed", stage: "process", code: "OBS_CONNECTION_LOST" };
    }
    return this.state;
  }

  async ensure(): Promise<ManagedObsState> {
    if (this.state.status === "ready" && this.client) return this.getState();
    if (this.running) return this.running;
    const generation = ++this.generation;
    this.running = this.start(generation).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private fail(stage: Extract<ManagedObsState, { status: "failed" }>["stage"], code: string): ManagedObsState {
    this.state = { status: "failed", stage, code };
    return this.state;
  }

  private async prepareConfiguration(): Promise<ManagedObsState | null> {
    try {
      this.password = await this.options.secretStore.loadOrCreate();
    } catch (error) {
      const code = error instanceof ManagedObsSecretError ? error.code : "OBS_SECURE_STORAGE_FAILED";
      return this.fail("configuration", code);
    }
    try {
      await prepareManagedObsRuntime(this.options.templateRoot, this.options.runtimeRoot, this.password);
      return null;
    } catch {
      return this.fail("configuration", "OBS_CONFIG_WRITE_FAILED");
    }
  }

  private async stopStaleDedicatedProcesses(): Promise<boolean> {
    const executable = managedObsExecutable(this.options.runtimeRoot);
    const managedPids = listManagedObsProcesses(executable);
    for (const pid of managedPids) {
      try {
        process.kill(pid);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
      }
    }
    if (!managedPids.length) return true;
    const deadline = Date.now() + PROCESS_STOP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!listManagedObsProcesses(executable).length) return true;
      await wait(200);
    }
    return false;
  }

  private async start(generation: number): Promise<ManagedObsState> {
    if (!existsSync(managedObsExecutable(this.options.templateRoot))) {
      this.state = { status: "not-installed" };
      return this.state;
    }

    if (!this.reconciledStaleProcess && !this.process) {
      if (!(await this.stopStaleDedicatedProcesses())) {
        return this.fail("process", "OBS_PROCESS_TERMINATION_FAILED");
      }
      this.reconciledStaleProcess = true;
    }

    const external = listExternalObsProcesses(managedObsExecutable(this.options.runtimeRoot));
    if (external.length) {
      this.state = { status: "blocked-by-external-obs", processes: external };
      return this.state;
    }

    if (!this.process && await canConnectToManagedObs()) {
      return this.fail("port", "OBS_PORT_IN_USE");
    }

    const configurationFailure = await this.prepareConfiguration();
    if (configurationFailure) return configurationFailure;

    const installation = detectManagedObs(this.options.runtimeRoot);
    if (!installation) {
      this.state = { status: "not-installed" };
      return this.state;
    }

    let exitedEarly = false;
    let spawnFailed = false;
    if (!this.process) {
      try {
        const owned = startOwnedObs(installation);
        this.process = owned;
        owned.child.once("error", () => {
          spawnFailed = true;
          if (this.process === owned) this.process = null;
        });
        owned.child.once("exit", () => {
          exitedEarly = true;
          if (this.process === owned) this.process = null;
          if (this.generation === generation && this.state.status === "ready") {
            this.client = null;
            this.state = { status: "failed", stage: "process", code: "OBS_PROCESS_EXITED" };
          }
        });
      } catch {
        return this.fail("process", "OBS_SPAWN_FAILED");
      }
    }

    const deadline = Date.now() + MANAGED_OBS_STARTUP_TIMEOUT_MS;
    let attempt = 0;
    let portWasOpen = false;
    while (Date.now() < deadline) {
      if (generation !== this.generation) return this.state;
      if (spawnFailed) return this.fail("process", "OBS_SPAWN_FAILED");
      if (exitedEarly || !this.process) return this.fail("process", "OBS_PROCESS_EXITED");
      attempt += 1;
      this.state = { status: "starting", attempt, maxAttempts: MAX_STARTUP_ATTEMPTS };
      if (await canConnectToManagedObs()) {
        portWasOpen = true;
        const result = await this.authenticateAndConfigure(generation);
        if (result.status !== "failed" || result.stage !== "auth") return result;
      }
      if (Date.now() < deadline) await wait(PORT_POLL_INTERVAL_MS);
    }
    return this.fail(portWasOpen ? "auth" : "port", portWasOpen ? "OBS_AUTH_FAILED" : "OBS_PORT_NOT_READY");
  }

  private async authenticateAndConfigure(generation: number): Promise<ManagedObsState> {
    if (!this.password) return this.fail("configuration", "OBS_SECURE_STORAGE_FAILED");
    const client = new OBSWebSocket();
    try {
      const identified = await client.connect(`ws://127.0.0.1:${MANAGED_OBS_PORT}`, this.password, { rpcVersion: 1 });
      if (generation !== this.generation) {
        await client.disconnect().catch(() => undefined);
        return this.state;
      }
      const version = await client.call("GetVersion") as { obsVersion?: string };
      this.obsVersion = version.obsVersion || identified.obsWebSocketVersion || this.obsVersion;
    } catch {
      await client.disconnect().catch(() => undefined);
      return this.fail("auth", "OBS_AUTH_FAILED");
    }

    try {
      await configureManagedObsScene(client, this.options.stageUrl);
    } catch {
      await client.disconnect().catch(() => undefined);
      return this.fail("scene", "OBS_SCENE_CONFIG_FAILED");
    }

    try {
      if (this.options.isVirtualCameraRegistered && !(await this.options.isVirtualCameraRegistered())) {
        await client.disconnect().catch(() => undefined);
        return this.fail("virtual-camera", "OBS_VIRTUAL_CAMERA_NOT_REGISTERED");
      }
      await reconcileVirtualCameraState(client, true);
    } catch {
      await client.disconnect().catch(() => undefined);
      return this.fail("virtual-camera", "OBS_VIRTUAL_CAMERA_FAILED");
    }

    this.client = client;
    client.once("ConnectionClosed", () => {
      if (this.client !== client) return;
      this.client = null;
      if (this.state.status !== "stopped") {
        this.state = { status: "failed", stage: "process", code: "OBS_CONNECTION_LOST" };
      }
    });
    this.state = { status: "ready", version: this.obsVersion, virtualCameraActive: true };
    return this.state;
  }

  private async connectedClient(): Promise<OBSWebSocket | null> {
    if (this.client && this.state.status === "ready") return this.client;
    if (this.running) await this.running;
    return this.client;
  }

  async setVirtualCamera(active: boolean): Promise<ManagedObsState> {
    const client = await this.connectedClient();
    if (!client) return this.fail("process", "OBS_NOT_RUNNING");
    try {
      await reconcileVirtualCameraState(client, active);
      this.state = { status: "ready", version: this.obsVersion, virtualCameraActive: active };
      return this.state;
    } catch {
      return this.fail("virtual-camera", "OBS_VIRTUAL_CAMERA_FAILED");
    }
  }

  async setInterventionRouting(action: InterventionAction): Promise<ManagedObsState> {
    const client = await this.connectedClient();
    if (!client) return this.fail("process", "OBS_NOT_RUNNING");
    try {
      await setManagedObsInterventionRouting(client, action);
      return this.getState();
    } catch {
      return this.fail("scene", "OBS_INTERVENTION_ROUTING_FAILED");
    }
  }

  async reset(): Promise<ManagedObsState> {
    const stopped = await this.stop();
    if (stopped.status === "failed") return stopped;
    await rm(this.options.runtimeRoot, { recursive: true, force: true });
    this.reconciledStaleProcess = false;
    this.state = { status: "idle" };
    return this.ensure();
  }

  async stop(): Promise<ManagedObsState> {
    this.generation += 1;
    this.state = { status: "stopped" };
    const client = this.client;
    this.client = null;
    if (client) {
      try {
        await reconcileVirtualCameraState(client, false);
      } catch {
        // The process may already be exiting.
      }
      await client.disconnect().catch(() => undefined);
    }

    const owned = this.process;
    this.process = null;
    if (owned) {
      try {
        const exited = owned.child.exitCode !== null
          ? Promise.resolve(true)
          : new Promise<boolean>((resolve) => {
              const onExit = () => resolve(true);
              owned.child.once("exit", onExit);
              setTimeout(() => {
                owned.child.removeListener("exit", onExit);
                resolve(owned.child.exitCode !== null);
              }, PROCESS_STOP_TIMEOUT_MS).unref();
            });
        if (owned.child.exitCode === null && !owned.child.kill("SIGTERM")) {
          throw new Error("OBS process rejected termination");
        }
        if (!(await exited)) throw new Error("OBS process did not exit in time");
      } catch {
        this.password = null;
        return this.fail("process", "OBS_PROCESS_TERMINATION_FAILED");
      }
    }
    this.password = null;
    return this.state;
  }
}
