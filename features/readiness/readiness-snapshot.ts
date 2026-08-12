import type { InterviewReadinessInput } from "./interview-readiness";

export const READINESS_SNAPSHOT_KEY = "ai-digital-human:readiness:v1";
export const READINESS_VERIFICATION_TTL_MS = 5 * 60_000;

export type ReadinessVerificationId = "speechReady" | "obsConnected" | "virtualCameraActive" | "virtualCameraVerified" | "virtualAudioReady" | "meetingPreviewConfirmed";
export type ReadinessSnapshot = Partial<Record<ReadinessVerificationId, number>>;

const verificationIds: ReadinessVerificationId[] = ["speechReady", "obsConnected", "virtualCameraActive", "virtualCameraVerified", "virtualAudioReady", "meetingPreviewConfirmed"];

export function parseReadinessSnapshot(value: string | null): ReadinessSnapshot {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(verificationIds.flatMap((id) => {
      const timestamp = (parsed as Record<string, unknown>)[id];
      return typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp > 0 ? [[id, timestamp]] : [];
    }));
  } catch { return {}; }
}

export function getSnapshotReadiness(snapshot: ReadinessSnapshot, now = Date.now()): Pick<InterviewReadinessInput, ReadinessVerificationId> {
  return Object.fromEntries(verificationIds.map((id) => [id, typeof snapshot[id] === "number" && now - snapshot[id]! < READINESS_VERIFICATION_TTL_MS])) as Pick<InterviewReadinessInput, ReadinessVerificationId>;
}

export function updateReadinessSnapshot(snapshot: ReadinessSnapshot, id: ReadinessVerificationId, ready: boolean, now = Date.now()): ReadinessSnapshot {
  const next = { ...snapshot };
  if (ready) next[id] = now; else delete next[id];
  if (!next.virtualCameraActive) {
    delete next.virtualCameraVerified; delete next.virtualAudioReady; delete next.meetingPreviewConfirmed;
  } else if (!next.virtualCameraVerified || !next.virtualAudioReady) delete next.meetingPreviewConfirmed;
  return next;
}

export function loadReadinessSnapshot(): ReadinessSnapshot {
  if (typeof window === "undefined") return {};
  return parseReadinessSnapshot(window.sessionStorage.getItem(READINESS_SNAPSHOT_KEY));
}

export function saveReadinessSnapshot(snapshot: ReadinessSnapshot) {
  if (typeof window !== "undefined") window.sessionStorage.setItem(READINESS_SNAPSHOT_KEY, JSON.stringify(snapshot));
}

export function setReadinessVerification(id: ReadinessVerificationId, ready: boolean) {
  const next = updateReadinessSnapshot(loadReadinessSnapshot(), id, ready);
  saveReadinessSnapshot(next);
  return next;
}

export function invalidateDeviceReadiness() {
  let snapshot = loadReadinessSnapshot();
  for (const id of ["virtualCameraVerified", "virtualAudioReady", "meetingPreviewConfirmed"] as const) snapshot = updateReadinessSnapshot(snapshot, id, false);
  saveReadinessSnapshot(snapshot);
}
