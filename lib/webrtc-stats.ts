export type RtcNetworkStats = {
  rttMs: number | null;
  packetLossPct: number | null;
  packetsLost: number;
  packetsSentOrReceived: number;
};

type StatsRecord = Record<string, unknown>;

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function collectRecords(report: Iterable<unknown>) {
  const records: StatsRecord[] = [];
  for (const entry of report) {
    if (entry && typeof entry === "object") records.push(entry as StatsRecord);
  }
  return records;
}

export function summarizeRtcStats(reports: Iterable<Iterable<unknown>>): RtcNetworkStats {
  let rttMs: number | null = null;
  let packetsLost = 0;
  let packetsCounted = 0;
  let fractionLoss: number | null = null;

  for (const report of reports) {
    for (const stat of collectRecords(report)) {
      const type = String(stat.type || "");
      if (type === "candidate-pair" && (stat.nominated === true || stat.state === "succeeded")) {
        const pairRtt = numberValue(stat.currentRoundTripTime);
        if (pairRtt != null) rttMs = Math.round(pairRtt * 1000);
      }
      if (type === "remote-inbound-rtp") {
        const remoteRtt = numberValue(stat.roundTripTime);
        if (remoteRtt != null && rttMs == null) rttMs = Math.round(remoteRtt * 1000);
        const lost = numberValue(stat.packetsLost) || 0;
        const received = numberValue(stat.packetsReceived) || 0;
        packetsLost += lost;
        packetsCounted += lost + received;
        const fraction = numberValue(stat.fractionLost);
        if (fraction != null) fractionLoss = fraction;
      }
      if (type === "inbound-rtp") {
        const lost = numberValue(stat.packetsLost) || 0;
        const received = numberValue(stat.packetsReceived) || 0;
        packetsLost += lost;
        packetsCounted += lost + received;
      }
    }
  }

  let packetLossPct: number | null = null;
  if (packetsCounted > 0) {
    packetLossPct = Math.round((packetsLost / packetsCounted) * 1000) / 10;
  } else if (fractionLoss != null) {
    packetLossPct = Math.round(fractionLoss * 1000) / 10;
  }

  return {
    rttMs,
    packetLossPct,
    packetsLost,
    packetsSentOrReceived: packetsCounted
  };
}

export function formatPacketLoss(packetLossPct: number | null) {
  if (packetLossPct == null) return "丢包 —";
  return `丢包 ${packetLossPct.toFixed(1)}%`;
}

export function formatRtt(rttMs: number | null) {
  if (rttMs == null) return "延时 —";
  return `延时 ${rttMs}ms`;
}
