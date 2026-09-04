import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Shell } from "./shell";

describe("Shell", () => {
  beforeEach(() => {
    window.location.hash = "";
  });
  afterEach(cleanup);

  it("renders navigation and default workspace page", () => {
    render(<Shell />);
    expect(screen.getByRole("navigation", { name: "主导航" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("工作台");
  });

  it("renders records page when hash is #/records", () => {
    window.location.hash = "#/records";
    render(<Shell />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("记录");
  });

  it("renders materials page when hash is #/materials", () => {
    window.location.hash = "#/materials";
    render(<Shell />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("资料");
  });

  it("renders services page when hash is #/services", () => {
    window.location.hash = "#/services";
    render(<Shell />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("服务");
  });

  it("renders settings page when hash is #/settings", () => {
    window.location.hash = "#/settings";
    render(<Shell />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("设置与诊断");
  });

  it("clicking nav button changes the displayed page", () => {
    render(<Shell />);
    const recordsButton = screen.getByRole("button", { name: "记录" });
    fireEvent.click(recordsButton);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("记录");
  });
});
