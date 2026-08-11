import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";

const destination = path.join(process.cwd(), "public", "vendor", "vad");
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });

const assets = [
  ["node_modules/@ricky0123/vad-web/dist/vad.worklet.bundle.min.js", "vad.worklet.bundle.min.js"],
  ["node_modules/@ricky0123/vad-web/dist/silero_vad_v5.onnx", "silero_vad_v5.onnx"],
  ["node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm", "ort-wasm-simd-threaded.wasm"]
];

await Promise.all(assets.map(([source, filename]) => cp(source, path.join(destination, filename))));
process.stdout.write("VAD browser assets ready\n");
