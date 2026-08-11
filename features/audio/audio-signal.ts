export function calculatePcmRms(samples: Uint8Array) {
  if (samples.length === 0) return 0;
  let sumSquares = 0;
  for (const sample of samples) {
    const normalized = (sample - 128) / 128;
    sumSquares += normalized * normalized;
  }
  return Math.sqrt(sumSquares / samples.length);
}

export function hasMeaningfulAudioSignal(peakRms: number, baselineRms: number) {
  const requiredRms = Math.max(0.015, baselineRms * 3 + 0.004);
  return peakRms >= requiredRms;
}
