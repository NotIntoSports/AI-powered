import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseTimeoutMilliseconds } from "./request-timeout";

const scriptPath = path.join(process.cwd(), "scripts", "sapi-tts.ps1");
const voicesScriptPath = path.join(process.cwd(), "scripts", "sapi-voices.ps1");

const globalTts = globalThis as typeof globalThis & {
  sapiQueue?: Promise<unknown>;
  sapiVoicesPromise?: Promise<Array<{ name: string; culture: string }>>;
};
const sapiSynthesisTimeoutMs = parseTimeoutMilliseconds(
  process.env.SAPI_SYNTHESIS_TIMEOUT_MS,
  30_000
);
const sapiVoiceListTimeoutMs = parseTimeoutMilliseconds(
  process.env.SAPI_VOICE_LIST_TIMEOUT_MS,
  10_000
);

async function synthesize(text: string) {
  if (process.platform !== "win32") throw new Error("SAPI_UNAVAILABLE");
  const outputPath = path.join(os.tmpdir(), `ai-interviewer-tts-${crypto.randomUUID()}.wav`);
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          scriptPath,
          "-OutputPath",
          outputPath
        ],
        {
          windowsHide: true,
          stdio: ["pipe", "ignore", "pipe"]
        }
      );
      let settled = false;
      let errorText = "";
      const finish = (cause?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (cause) reject(cause);
        else resolve();
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(new Error("SAPI_TIMEOUT"));
      }, sapiSynthesisTimeoutMs);
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        if (errorText.length < 4_000) errorText += chunk;
      });
      child.once("error", (cause) => finish(cause));
      child.once("exit", (code) => {
        if (code === 0) finish();
        else finish(new Error(errorText.trim() || "SAPI_FAILED"));
      });
      child.stdin.once("error", (cause) => finish(cause));
      child.stdin.end(text, "utf8");
    });
    return await readFile(outputPath);
  } finally {
    await rm(outputPath, { force: true }).catch(() => undefined);
  }
}

export function synthesizeWindowsSpeech(text: string) {
  const task = (globalTts.sapiQueue ?? Promise.resolve()).then(() => synthesize(text));
  globalTts.sapiQueue = task.catch(() => undefined);
  return task;
}

export function listWindowsSpeechVoices(): Promise<Array<{ name: string; culture: string }>> {
  if (globalTts.sapiVoicesPromise) return globalTts.sapiVoicesPromise;
  const request = new Promise<Array<{ name: string; culture: string }>>((resolve, reject) => {
    if (process.platform !== "win32") {
      resolve([]);
      return;
    }
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        voicesScriptPath
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
    );
    let settled = false;
    let output = "";
    let errorText = "";
    const finish = (
      voices?: Array<{ name: string; culture: string }>,
      cause?: unknown
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (cause) reject(cause);
      else resolve(voices || []);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(undefined, new Error("SAPI_VOICE_LIST_TIMEOUT"));
    }, sapiVoiceListTimeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (output.length < 64_000) output += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      if (errorText.length < 4_000) errorText += chunk;
    });
    child.once("error", (cause) => finish(undefined, cause));
    child.once("exit", (code) => {
      if (code !== 0) {
        finish(undefined, new Error(errorText.trim() || "SAPI_VOICE_LIST_FAILED"));
        return;
      }
      try {
        const parsed = JSON.parse(output || "[]");
        if (!Array.isArray(parsed)) throw new Error("SAPI_VOICE_LIST_INVALID");
        finish(parsed.filter((voice): voice is { name: string; culture: string } =>
          typeof voice?.name === "string" && typeof voice?.culture === "string"
        ));
      } catch (cause) {
        finish(undefined, cause);
      }
    });
  }).catch((cause) => {
    globalTts.sapiVoicesPromise = undefined;
    throw cause;
  });
  globalTts.sapiVoicesPromise = request;
  return request;
}
