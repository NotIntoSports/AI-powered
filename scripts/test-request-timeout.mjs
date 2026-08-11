import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile("lib/request-timeout.ts", "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022
  }
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
const { fetchWithTimeout, parseTimeoutMilliseconds } = await import(moduleUrl);

assert.equal(parseTimeoutMilliseconds(undefined, 60_000), 60_000);
assert.equal(parseTimeoutMilliseconds("250", 60_000), 1_000);
assert.equal(parseTimeoutMilliseconds("900000", 60_000), 600_000);
assert.equal(parseTimeoutMilliseconds("invalid", 60_000), 60_000);

const originalFetch = globalThis.fetch;
globalThis.fetch = async (_input, init) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => resolve(new Response("{}")), 1_000);
  init.signal.addEventListener("abort", () => {
    clearTimeout(timer);
    reject(init.signal.reason);
  }, { once: true });
});
try {
  await assert.rejects(
    fetchWithTimeout("https://example.invalid", { method: "GET" }, 10),
    /MODEL_TIMEOUT/
  );
} finally {
  globalThis.fetch = originalFetch;
}

process.stdout.write("request timeout configuration test passed\n");
