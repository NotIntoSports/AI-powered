import { cp, mkdir, rm, stat } from "node:fs/promises";
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

await Promise.all([
  requireDirectory(standaloneRoot),
  requireDirectory(path.join(root, ".next", "static")),
  requireDirectory(path.join(root, "public"))
]);

const serverFile = path.join(standaloneRoot, "server.js");
const serverInfo = await stat(serverFile).catch(() => null);
if (!serverInfo?.isFile()) throw new Error("Next standalone root server.js was not produced");

await rm(outputRoot, { recursive: true, force: true });
await cp(standaloneRoot, outputRoot, { recursive: true });
await mkdir(path.join(outputRoot, ".next"), { recursive: true });
await cp(path.join(root, ".next", "static"), path.join(outputRoot, ".next", "static"), {
  recursive: true
});
await cp(path.join(root, "public"), path.join(outputRoot, "public"), { recursive: true });

await Promise.all([
  stat(path.join(outputRoot, "server.js")),
  stat(path.join(outputRoot, "node_modules", "next", "package.json")),
  stat(path.join(
    outputRoot,
    "node_modules",
    "next",
    "dist",
    "compiled",
    "@mswjs",
    "interceptors",
    "ClientRequest",
    "index.js"
  ))
]);

process.stdout.write(`Desktop runtime ready: ${outputRoot}\n`);
