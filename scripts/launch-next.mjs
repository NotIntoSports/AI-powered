import { openSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const mode = process.argv[2];
const port = Number(process.argv[3] || 3000);
const stdoutPath = process.argv[4];
const stderrPath = process.argv[5];
if (!["dev", "start"].includes(mode) || !Number.isInteger(port) || port < 1 || port > 65535 || !stdoutPath || !stderrPath) {
  throw new Error("Usage: launch-next.mjs <dev|start> <port> <stdout-path> <stderr-path>");
}

const nextCli = path.join(process.cwd(), "node_modules", "next", "dist", "bin", "next");
const stdout = openSync(stdoutPath, "a");
const stderr = openSync(stderrPath, "a");
const child = spawn(process.execPath, [nextCli, mode, "-H", "127.0.0.1", "-p", String(port)], {
  cwd: process.cwd(),
  detached: true,
  windowsHide: true,
  stdio: ["ignore", stdout, stderr]
});
child.unref();
process.stdout.write(String(child.pid));
