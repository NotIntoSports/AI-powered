export type NetworkQualitySnapshot = {
  managementReachable: boolean;
  managementRttMs: number | null;
  rtcConnected: boolean;
  rtcRttMs: number | null;
  packetLossPct: number | null;
};

const idleSnapshot: NetworkQualitySnapshot = {
  managementReachable: false,
  managementRttMs: null,
  rtcConnected: false,
  rtcRttMs: null,
  packetLossPct: null
};

let snapshot: NetworkQualitySnapshot = idleSnapshot;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

export function getNetworkQuality() {
  return snapshot;
}

export function subscribeNetworkQuality(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setManagementNetwork(input: { reachable: boolean; rttMs: number | null }) {
  snapshot = {
    ...snapshot,
    managementReachable: input.reachable,
    managementRttMs: input.rttMs
  };
  notify();
}

export function setRtcNetwork(input: {
  connected: boolean;
  rttMs?: number | null;
  packetLossPct?: number | null;
}) {
  snapshot = {
    ...snapshot,
    rtcConnected: input.connected,
    rtcRttMs: input.connected ? input.rttMs ?? snapshot.rtcRttMs : null,
    packetLossPct: input.connected ? input.packetLossPct ?? snapshot.packetLossPct : null
  };
  notify();
}

export function networkStatus(quality: NetworkQualitySnapshot = snapshot) {
  if (!quality.managementReachable) return "bad" as const;
  const rtt = quality.rtcRttMs ?? quality.managementRttMs;
  const loss = quality.packetLossPct;
  if ((rtt != null && rtt >= 200) || (loss != null && loss >= 5)) return "warn" as const;
  if (loss != null && loss >= 1) return "warn" as const;
  return "ok" as const;
}

export function describeNetwork(quality: NetworkQualitySnapshot = snapshot) {
  if (!quality.managementReachable) {
    return quality.managementRttMs != null
      ? `管理端不可达 · ${quality.managementRttMs}ms`
      : "管理端不可达";
  }
  const rtt = quality.rtcRttMs ?? quality.managementRttMs;
  const parts = [rtt != null ? `延时 ${rtt}ms` : "延时 —"];
  if (quality.rtcConnected) {
    parts.push(quality.packetLossPct != null ? `丢包 ${quality.packetLossPct.toFixed(1)}%` : "丢包统计中");
  } else {
    parts.push("启动实时字幕后显示丢包");
  }
  return parts.join(" · ");
}
