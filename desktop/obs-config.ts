import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const MANAGED_OBS_PORT = 4455;
export const MANAGED_OBS_CONFIG_VERSION = 2;

export interface ManagedObsWebSocketConfiguration {
  alerts_enabled: false;
  auth_required: true;
  first_load: false;
  server_enabled: true;
  server_password: string;
  server_port: number;
}

export function managedObsWebSocketConfigPath(runtimeRoot: string): string {
  return path.join(
    runtimeRoot,
    "config",
    "obs-studio",
    "plugin_config",
    "obs-websocket",
    "config.json"
  );
}

export function buildManagedObsWebSocketConfiguration(
  password: string,
  port = MANAGED_OBS_PORT
): ManagedObsWebSocketConfiguration {
  return {
    alerts_enabled: false,
    auth_required: true,
    first_load: false,
    server_enabled: true,
    server_password: password,
    server_port: port
  };
}

export async function writeManagedObsWebSocketConfiguration(
  runtimeRoot: string,
  password: string,
  port = MANAGED_OBS_PORT
): Promise<void> {
  const configPath = managedObsWebSocketConfigPath(runtimeRoot);
  const temporaryPath = `${configPath}.${process.pid}.tmp`;
  await mkdir(path.dirname(configPath), { recursive: true });
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify(buildManagedObsWebSocketConfiguration(password, port), null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
    await rename(temporaryPath, configPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
