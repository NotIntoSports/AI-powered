import { spawn, execFile } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const WINDOW_TIMEOUT_MS = 15_000;
const ISOLATION_SUPPORT_MARKER = "AI_VIRTUAL_ASSISTANT_ISOLATION_V1";
const FORBIDDEN_PROCESS_NAMES = new Set([
  "node.exe",
  "control-api",
  "control-api.exe",
  "python.exe",
  "postgres",
  "postgres.exe",
  "nginx",
  "nginx.exe",
]);

export async function requirePackagedExecutable(executablePath) {
  const absolutePath = resolve(executablePath);
  try {
    await access(absolutePath, constants.F_OK);
  } catch {
    throw new Error(`Packaged executable does not exist: ${absolutePath}`);
  }
  return absolutePath;
}

export function buildIsolatedLaunchEnvironment(sourceEnvironment, webviewDataFolder) {
  const environment = Object.fromEntries(
    Object.entries(sourceEnvironment).filter(([key]) => !new Set([
      "APPDATA",
      "LOCALAPPDATA",
      "AI_VIRTUAL_ASSISTANT_CONFIG",
    ]).has(key.toUpperCase()) && !key.toUpperCase().startsWith("WEBVIEW2_")),
  );
  if (webviewDataFolder !== undefined) {
    environment.WEBVIEW2_USER_DATA_FOLDER = webviewDataFolder;
  }
  return environment;
}

export async function verifyIsolationSupport(executablePath, dependencies = {}) {
  const readBinary = dependencies.readBinary ?? readFile;
  const runProbe = dependencies.runProbe ?? execFileAsync;
  const binary = await readBinary(executablePath);
  if (!Buffer.from(binary).includes(Buffer.from(ISOLATION_SUPPORT_MARKER))) {
    throw new Error(`Packaged executable does not contain the isolation support marker: ${executablePath}`);
  }
  const { stdout } = await runProbe(executablePath, ["--check-isolation-support"], {
    env: buildIsolatedLaunchEnvironment(process.env),
    windowsHide: true,
    timeout: 5_000,
  });
  if (stdout !== ISOLATION_SUPPORT_MARKER) {
    throw new Error(`Packaged executable returned an invalid isolation support response: ${executablePath}`);
  }
}

export async function assertIsolationArtifacts(isolatedRoot) {
  const required = [
    [join(isolatedRoot, "config", "local.json"), "file"],
    [join(isolatedRoot, "data", "app.sqlite3"), "file"],
    [join(isolatedRoot, "logs"), "directory"],
    [join(isolatedRoot, "webview"), "directory"],
  ];
  for (const [path, expectedKind] of required) {
    let metadata;
    try {
      metadata = await stat(path);
    } catch {
      throw new Error(`Missing isolated startup artifact: ${path}`);
    }
    const matches = expectedKind === "file" ? metadata.isFile() : metadata.isDirectory();
    if (!matches) throw new Error(`Invalid isolated startup artifact: ${path} must be a ${expectedKind}`);
  }
}

async function listFiles(directory, root = directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(path, root));
    } else {
      files.push(relative(root, path));
    }
  }
  return files;
}

export async function assertBundleContainsNoPrivateFiles(bundleDirectory) {
  const forbidden = /(^|[\\/])(?:\.env(?:\..*)?|config[\\/]local\.json|[^\\/]*\.(?:db|sqlite|sqlite3|log)|[^\\/]*credential[^\\/]*fixture[^\\/]*)$/i;
  const offendingPath = (await listFiles(resolve(bundleDirectory))).find((path) => forbidden.test(path));
  if (offendingPath) {
    throw new Error(`Private runtime file found in bundle: ${offendingPath}`);
  }
}

export function assertAllowedProcessTree(processes) {
  const forbidden = processes.find(({ name }) => FORBIDDEN_PROCESS_NAMES.has(name.toLowerCase()));
  if (forbidden) {
    throw new Error(`Forbidden packaged child process detected: ${forbidden.name} (PID ${forbidden.processId})`);
  }
}

function processSnapshotScript(rootPid) {
  return `
$rootPid = ${rootPid}
$all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name)
$ids = [System.Collections.Generic.HashSet[uint32]]::new()
$pending = [System.Collections.Generic.Queue[uint32]]::new()
[void]$ids.Add([uint32]$rootPid)
$pending.Enqueue([uint32]$rootPid)
while ($pending.Count -gt 0) {
  $parentId = $pending.Dequeue()
  foreach ($child in $all | Where-Object ParentProcessId -eq $parentId) {
    if ($ids.Add([uint32]$child.ProcessId)) { $pending.Enqueue([uint32]$child.ProcessId) }
  }
}
$processes = @($all | Where-Object { $ids.Contains([uint32]$_.ProcessId) } | ForEach-Object {
  [pscustomobject]@{ processId = [int]$_.ProcessId; parentProcessId = [int]$_.ParentProcessId; name = $_.Name }
})
$root = Get-Process -Id $rootPid -ErrorAction SilentlyContinue
[pscustomobject]@{
  visible = [bool]($root -and $root.MainWindowHandle -ne 0)
  processes = $processes
} | ConvertTo-Json -Depth 4 -Compress
`;
}

async function inspectProcessTree(rootPid) {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", processSnapshotScript(rootPid)],
    { windowsHide: true },
  );
  const snapshot = JSON.parse(stdout.trim());
  snapshot.processes = Array.isArray(snapshot.processes)
    ? snapshot.processes
    : snapshot.processes ? [snapshot.processes] : [];
  return snapshot;
}

async function waitForVisibleWindow(rootPid) {
  const deadline = Date.now() + WINDOW_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const snapshot = await inspectProcessTree(rootPid);
    if (snapshot.visible) return snapshot;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`Packaged application did not expose a visible main window within ${WINDOW_TIMEOUT_MS / 1000} seconds`);
}

async function requestWindowClose(rootPid) {
  const script = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class NativeWindowClose {
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
}
'@
$process = Get-Process -Id ${rootPid} -ErrorAction Stop
if ($process.MainWindowHandle -eq 0) { throw 'Main window is unavailable.' }
if (-not [NativeWindowClose]::PostMessage($process.MainWindowHandle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)) {
  throw 'WM_CLOSE could not be posted.'
}
`;
  await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => rejectExit(new Error("Packaged application did not exit cleanly")), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolveExit(code);
    });
  });
}

async function runPackageSmoke() {
  if (process.platform !== "win32") throw new Error("The packaged Tauri smoke test requires Windows");

  const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const executable = await requirePackagedExecutable(
    process.env.TAURI_SMOKE_EXECUTABLE ?? join(repositoryRoot, "src-tauri", "target", "release", "role-ai-desktop.exe"),
  );
  const bundleDirectory = resolve(
    process.env.TAURI_SMOKE_BUNDLE ?? join(repositoryRoot, "src-tauri", "target", "release", "bundle"),
  );
  await assertBundleContainsNoPrivateFiles(bundleDirectory);
  await verifyIsolationSupport(executable);

  const isolatedRoot = await mkdtemp(join(tmpdir(), "ai-virtual-assistant-tauri-smoke-"));
  let child;
  try {
    child = spawn(executable, ["--isolated-root", isolatedRoot], {
      cwd: repositoryRoot,
      env: buildIsolatedLaunchEnvironment(process.env, join(isolatedRoot, "webview")),
      stdio: "ignore",
      windowsHide: false,
    });
    const snapshot = await waitForVisibleWindow(child.pid);
    assertAllowedProcessTree(snapshot.processes.filter(({ processId }) => processId !== child.pid));
    await assertIsolationArtifacts(isolatedRoot);
    await requestWindowClose(child.pid);
    const exitCode = await waitForExit(child, 5_000);
    if (exitCode !== 0) throw new Error(`Packaged application exited with code ${exitCode}`);
  } finally {
    if (child && child.exitCode === null) {
      child.kill();
      await waitForExit(child, 5_000);
    }
    // WebView2 can release cache handles shortly after its host has exited.
    // Node retries EBUSY/EPERM/ENOTEMPTY with bounded linear backoff (<= 21 s).
    await rm(isolatedRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
  console.log(`PASS: ${basename(executable)} opened an isolated visible window with no forbidden child process, exited cleanly, and its temporary data was removed.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPackageSmoke().catch((error) => {
    console.error(error instanceof Error ? error.message : "Packaged application smoke test failed");
    process.exitCode = 1;
  });
}
