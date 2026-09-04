import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const stylesDir = resolve(process.cwd(), "src/styles");

describe("shell CSS contract", () => {
  const shellCss = readFileSync(resolve(stylesDir, "shell.css"), "utf8");
  const foundationCss = readFileSync(resolve(stylesDir, "foundation.css"), "utf8");

  it("shell.css contains required layout classes", () => {
    expect(shellCss).toContain(".app-shell");
    expect(shellCss).toContain(".app-nav");
    expect(shellCss).toContain(".app-main");
    expect(shellCss).toContain(".page-placeholder");
  });

  it("shell.css does not use !important", () => {
    expect(shellCss).not.toContain("!important");
  });

  it("foundation.css still contains repair classes (not broken)", () => {
    expect(foundationCss).toContain(".foundation-shell");
    expect(foundationCss).toContain(".foundation-card");
    expect(foundationCss).toContain(".repair-card");
  });
});
