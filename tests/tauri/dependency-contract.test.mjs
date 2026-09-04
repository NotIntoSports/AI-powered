import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("frontend and Rust foundation dependencies are locked", async () => {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  const cargo = await readFile("src-tauri/Cargo.toml", "utf8");

  assert.equal(pkg.dependencies["@tauri-apps/api"], "2.11.1");
  assert.equal(pkg.devDependencies["@tauri-apps/cli"], "2.11.4");
  assert.equal(pkg.devDependencies.vite, "8.2.2");
  assert.equal(pkg.dependencies.react, "19.2.8");
  assert.equal(pkg.dependencies["react-dom"], "19.2.8");
  assert.match(cargo, /tauri\s*=\s*\{\s*version\s*=\s*"=?2/);
  assert.match(cargo, /keyring/);
  assert.match(cargo, /rusqlite/);
  assert.match(cargo, /ts-rs/);
});
