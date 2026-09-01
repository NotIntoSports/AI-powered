import { execFile } from "node:child_process";

type RouteResult = { changed: boolean; previousId: string; cableId: string; cableLabel: string };

function run(executablePath: string, args: string[]) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(executablePath, args, { windowsHide: true, timeout: 10_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).trim().slice(0, 240)));
      else resolve({ stdout, stderr });
    });
  });
}

export class CommunicationsMicrophoneRouter {
  private previousId = "";
  private activeMeetingPid = 0;
  private readonly runCommand: typeof run;
  constructor(runCommand: typeof run = run) { this.runCommand = runCommand; }

  async activate(executablePath: string, meetingPid: number) {
    if (this.activeMeetingPid === meetingPid) return;
    await this.restore(executablePath);
    const { stdout } = await this.runCommand(executablePath, ["--set-default-communications-mic"]);
    const result = JSON.parse(stdout.trim()) as RouteResult;
    if (!result.cableId || !result.cableLabel || typeof result.changed !== "boolean") {
      throw new Error("INVALID_COMMUNICATIONS_MIC_RESULT");
    }
    this.previousId = result.changed ? result.previousId : "";
    this.activeMeetingPid = meetingPid;
    return { cableLabel: result.cableLabel };
  }

  async restore(executablePath: string) {
    const previousId = this.previousId;
    this.previousId = "";
    this.activeMeetingPid = 0;
    if (previousId) await this.runCommand(executablePath, ["--restore-default-communications-mic", previousId]);
  }
}
