import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile("lib/request-origin.ts", "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022
  }
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
const { isTrustedMutationRequest } = await import(moduleUrl);

function request(method, headers = {}, url = "http://127.0.0.1:3000/api/session") {
  return { method, url, headers: new Headers(headers) };
}

assert.equal(isTrustedMutationRequest(request("GET", {
  origin: "https://attacker.example",
  "sec-fetch-site": "cross-site"
})), true);
assert.equal(isTrustedMutationRequest(request("POST", {
  origin: "http://127.0.0.1:3000",
  "sec-fetch-site": "same-origin"
})), true);
assert.equal(isTrustedMutationRequest({
  ...request("POST", {
    origin: "http://127.0.0.1:3000",
    "sec-fetch-site": "same-origin"
  }, "http://localhost:3000/api/session"),
  targetOrigin: "http://127.0.0.1:3000"
}), true);
assert.equal(isTrustedMutationRequest(request("POST")), true);
assert.equal(isTrustedMutationRequest(request("POST", {
  origin: "https://attacker.example",
  "sec-fetch-site": "cross-site"
})), false);
assert.equal(isTrustedMutationRequest(request("POST", {
  origin: "null"
})), false);
assert.equal(isTrustedMutationRequest(request("POST", {
  origin: "http://127.0.0.1:3001",
  "sec-fetch-site": "same-site"
})), false);
assert.equal(isTrustedMutationRequest(request("POST", {
  origin: "http://127.0.0.1:3000.attacker.example"
})), false);
assert.equal(isTrustedMutationRequest(request("DELETE", {
  "sec-fetch-site": "cross-site"
})), false);

process.stdout.write("request origin guard test passed\n");
