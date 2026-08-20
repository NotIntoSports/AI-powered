export const CLONE_MIN_SECONDS = 8;
export const CLONE_MAX_SECONDS = 25;
export const CLONE_SAMPLE_RATE = 24_000;
export const MAX_CLONE_AUDIO_BYTES = 10 * 1024 * 1024;

export type CloneDurationStatus = "ok" | "too-short" | "too-long";

export function cloneDurationStatus(seconds: number): CloneDurationStatus {
  if (!Number.isFinite(seconds) || seconds < CLONE_MIN_SECONDS) return "too-short";
  if (seconds > CLONE_MAX_SECONDS) return "too-long";
  return "ok";
}

export function clampCloneSampleCount(sampleCount: number, sampleRate = CLONE_SAMPLE_RATE) {
  const maxSamples = Math.floor(CLONE_MAX_SECONDS * sampleRate);
  return Math.min(Math.max(0, sampleCount), maxSamples);
}

export function concatFloat32(chunks: Float32Array[]) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

export function downsampleToRate(samples: Float32Array, fromRate: number, toRate = CLONE_SAMPLE_RATE) {
  if (fromRate === toRate) return samples;
  if (fromRate <= 0 || toRate <= 0) return samples;
  const ratio = fromRate / toRate;
  const length = Math.max(1, Math.floor(samples.length / ratio));
  const output = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const start = Math.floor(index * ratio);
    output[index] = samples[Math.min(start, samples.length - 1)] || 0;
  }
  return output;
}

export function encodePcm16Wav(samples: Float32Array, sampleRate = CLONE_SAMPLE_RATE) {
  const clamped = samples.subarray(0, clampCloneSampleCount(samples.length, sampleRate));
  const dataSize = clamped.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (let index = 0; index < clamped.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, clamped[index] || 0));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    offset += 2;
  }
  return new Uint8Array(buffer);
}

export function wrapPcmAsWav(pcm: Uint8Array, sampleRate = CLONE_SAMPLE_RATE) {
  if (pcm.length >= 12) {
    const header = String.fromCharCode(...pcm.slice(0, 4));
    const wave = String.fromCharCode(...pcm.slice(8, 12));
    if (header === "RIFF" && wave === "WAVE") return pcm;
  }
  const buffer = new ArrayBuffer(44 + pcm.length);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + pcm.length, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, pcm.length, true);
  new Uint8Array(buffer).set(pcm, 44);
  return new Uint8Array(buffer);
}

/** 把标准 PCM16 单声道 WAV 截断到最长 maxSeconds，并同步修正 RIFF/data 头长度。 */
export function truncateWavToSeconds(wav: Uint8Array, maxSeconds: number, sampleRate = CLONE_SAMPLE_RATE) {
  if (wav.length < 44) return wav;
  const header = String.fromCharCode(...wav.slice(0, 4));
  const wave = String.fromCharCode(...wav.slice(8, 12));
  if (header !== "RIFF" || wave !== "WAVE") return wav;
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const rate = view.getUint32(24, true) || sampleRate;
  const declaredDataSize = view.getUint32(40, true);
  const maxBytes = Math.floor(maxSeconds * rate) * 2;
  const available = Math.min(declaredDataSize, wav.length - 44);
  if (available <= maxBytes) return wav;
  const truncated = wav.slice(0, 44 + maxBytes);
  const target = new DataView(truncated.buffer, truncated.byteOffset, truncated.byteLength);
  target.setUint32(4, 36 + maxBytes, true);
  target.setUint32(40, maxBytes, true);
  return truncated;
}

function writeAscii(view: DataView, offset: number, value: string) {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}
