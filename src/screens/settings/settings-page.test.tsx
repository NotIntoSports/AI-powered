import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SettingsPage } from "./settings-page";

describe("SettingsPage", () => {
  afterEach(cleanup);

  it("renders the settings heading", () => {
    render(<SettingsPage />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("设置与诊断");
  });

  it("renders non-empty capabilities", () => {
    render(<SettingsPage />);
    const items = screen.getAllByRole("listitem");
    expect(items.length).toBeGreaterThan(0);
  });

  it("does not call fetch", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    render(<SettingsPage />);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("does not contain /api/ paths", () => {
    const { container } = render(<SettingsPage />);
    expect(container.innerHTML).not.toMatch(/\/api\//);
  });
});
