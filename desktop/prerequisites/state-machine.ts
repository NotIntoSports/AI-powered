export type InstallStep = "obs" | "virtual-camera" | "virtual-audio" | "complete";
export type InstallStatus = "not-started" | "installing" | "reboot-required" | "verifying" | "complete" | "failed";
export type InstallState = { step: InstallStep; status: InstallStatus; error?: string };

const nextStep: Record<Exclude<InstallStep, "complete">, InstallStep> = {
  obs: "virtual-camera",
  "virtual-camera": "virtual-audio",
  "virtual-audio": "complete"
};

export function advanceInstallState(state: InstallState, event: "start" | "installed" | "reboot" | "verified" | "retry", error?: string): InstallState {
  if (state.status === "complete") return state;
  if (event === "retry" && state.status === "failed") return { step: state.step, status: "not-started" };
  if (event === "start" && state.status === "not-started") return { step: state.step, status: "installing" };
  if (event === "reboot" && state.status === "installing") return { step: state.step, status: "reboot-required" };
  if (event === "installed" && state.status === "installing") return { step: state.step, status: "verifying" };
  if (event === "verified" && (state.status === "verifying" || state.status === "reboot-required")) {
    const step = nextStep[state.step as Exclude<InstallStep, "complete">];
    return { step, status: step === "complete" ? "complete" : "not-started" };
  }
  return { ...state, status: "failed", error: error || `Invalid transition: ${state.status}/${event}` };
}
