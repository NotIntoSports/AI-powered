export type VirtualCameraClient = {
  call(requestType: "GetVirtualCamStatus"): Promise<{ outputActive: boolean }>;
  call(requestType: "StartVirtualCam" | "StopVirtualCam"): Promise<unknown>;
};

type ReconcileOptions = {
  timeoutMs?: number;
  pollIntervalMs?: number;
  wait?: (milliseconds: number) => Promise<void>;
};

const defaultWait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export async function reconcileVirtualCameraState(
  client: VirtualCameraClient,
  active: boolean,
  options: ReconcileOptions = {}
): Promise<void> {
  const initial = await client.call("GetVirtualCamStatus");
  if (initial.outputActive === active) return;

  const command = active ? "StartVirtualCam" : "StopVirtualCam";
  let commandError: unknown;
  void client.call(command).catch((error) => {
    commandError = error;
  });

  const timeoutMs = options.timeoutMs ?? 2_000;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const attempts = Math.max(1, Math.ceil(timeoutMs / pollIntervalMs));
  const wait = options.wait ?? defaultWait;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await wait(pollIntervalMs);
    const status = await client.call("GetVirtualCamStatus");
    if (status.outputActive === active) return;
  }

  const expected = active ? "active" : "inactive";
  throw new Error(`OBS virtual camera did not become ${expected}`, commandError ? { cause: commandError } : undefined);
}
