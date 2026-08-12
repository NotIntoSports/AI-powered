import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import type { AudioCaptureEvent } from "./capture-protocol";
import { parseCaptureEvent } from "./capture-protocol";

export class AudioCaptureProcess {
  private child: ChildProcess | null = null;

  start(options: {
    executablePath: string;
    pid: number;
    onPcm(data: Uint8Array): void;
    onEvent(event: AudioCaptureEvent): void;
  }): void {
    this.stop();
    const child = spawn(options.executablePath, ["--pid", String(options.pid)], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => options.onPcm(new Uint8Array(chunk)));
    const lines = readline.createInterface({ input: child.stderr });
    lines.on("line", (line) => {
      try { options.onEvent(parseCaptureEvent(line)); }
      catch { options.onEvent({ type: "error", sequence: 0, code: "invalid-sidecar-event", message: "AudioBridge emitted an invalid event" }); }
    });
    child.once("exit", () => { if (this.child === child) this.child = null; });
  }

  stop(): void {
    this.child?.kill("SIGTERM");
    this.child = null;
  }
}
