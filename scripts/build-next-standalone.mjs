import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const standaloneRoot = path.join(root, ".next", "standalone");
const outputRoot = path.join(root, ".desktop-runtime");

async function requireDirectory(directory) {
  const info = await stat(directory).catch(() => null);
  if (!info?.isDirectory()) {
    throw new Error(`Required build directory is missing: ${directory}`);
  }
}

async function findServer(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isFile() && entry.name === "server.js") return candidate;
    if (entry.isDirectory()) {
      const nested = await findServer(candidate);
      if (nested) return nested;
    }
  }
  return null;
}

await Promise.all([
  requireDirectory(standaloneRoot),
  requireDirectory(path.join(root, ".next", "static")),
  requireDirectory(path.join(root, "public"))
]);

const serverFile = await findServer(standaloneRoot);
if (!serverFile) throw new Error("Next standalone server.js was not produced");

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
const serverRoot = path.dirname(serverFile);
await cp(serverRoot, outputRoot, { recursive: true });
await mkdir(path.join(outputRoot, ".next"), { recursive: true });
await cp(path.join(root, ".next", "static"), path.join(outputRoot, ".next", "static"), {
  recursive: true
});
await cp(path.join(root, "public"), path.join(outputRoot, "public"), { recursive: true });

process.stdout.write(`Desktop runtime ready: ${outputRoot}\n`);
