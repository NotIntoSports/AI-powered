import assert from "node:assert/strict";
import { writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyArtifact } from "../../desktop/prerequisites/verify.ts";

test("verifies pinned SHA-256 and rejects mismatches", async () => {
  const file = path.join(tmpdir(), `ai-interviewer-hash-${process.pid}.txt`);
  await writeFile(file, "verified", "utf8");
  try {
    assert.equal(await verifyArtifact(file, "1c34f88707b55e6104c4eb20e71ffa3d33e414b71ef689a15fad0640d0ac58cb"), true);
    assert.equal(await verifyArtifact(file, "0".repeat(64)), false);
  } finally { await rm(file, { force: true }); }
});
