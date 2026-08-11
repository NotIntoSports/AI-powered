import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile("lib/endpoint-security.ts", "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022
  }
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
const {
  areEquivalentBaseUrls,
  isSecureEndpoint,
  selectScopedApiKey
} = await import(moduleUrl);

assert.equal(isSecureEndpoint("https://speech.example.com/v1"), true);
assert.equal(isSecureEndpoint("http://127.0.0.1:8080/inference"), true);
assert.equal(isSecureEndpoint("http://localhost:8080/inference"), true);
assert.equal(isSecureEndpoint("http://speech.example.com/v1"), false);
assert.equal(isSecureEndpoint("ftp://127.0.0.1/audio"), false);
assert.equal(isSecureEndpoint("not a URL"), false);

assert.equal(
  areEquivalentBaseUrls("https://api.example.com/v1/", "https://api.example.com/v1"),
  true
);
assert.equal(
  areEquivalentBaseUrls("https://speech.example.com/v1", "https://api.example.com/v1"),
  false
);
assert.equal(
  areEquivalentBaseUrls("https://api.example.com/v1", "https://api.example.com/v2"),
  false
);

assert.equal(selectScopedApiKey({
  explicitKey: " speech-key ",
  targetBaseUrl: "https://speech.example.com/v1",
  fallbackBaseUrl: "https://model.example.com/v1",
  fallbackApiKey: "model-key"
}), "speech-key");
assert.equal(selectScopedApiKey({
  targetBaseUrl: "https://same.example.com/v1",
  fallbackBaseUrl: "https://same.example.com/v1/",
  fallbackApiKey: "model-key"
}), "model-key");
assert.equal(selectScopedApiKey({
  targetBaseUrl: "https://speech.example.com/v1",
  fallbackBaseUrl: "https://model.example.com/v1",
  fallbackApiKey: "must-not-leak"
}), "");

process.stdout.write("transcription endpoint security test passed\n");
