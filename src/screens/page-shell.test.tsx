import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PageShell } from "./page-shell";

describe("PageShell", () => {
  afterEach(cleanup);

  it("renders heading with the route label", () => {
    render(<PageShell id="workspace" />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("工作台");
  });

  it("renders design section reference", () => {
    render(<PageShell id="services" />);
    expect(screen.getByText(/Design §6\.4/)).toBeTruthy();
  });

  it("renders capabilities list", () => {
    render(<PageShell id="materials" />);
    const list = screen.getByRole("list");
    expect(list).toBeTruthy();
    expect(list.querySelectorAll("li").length).toBeGreaterThan(0);
  });

  it("renders placeholder status text", () => {
    render(<PageShell id="records" />);
    expect(screen.getByText(/尚未接入业务逻辑/)).toBeTruthy();
  });

  it("has region role with aria-labelledby", () => {
    render(<PageShell id="settings" />);
    const region = screen.getByRole("region");
    expect(region).toBeTruthy();
    expect(region.getAttribute("aria-labelledby")).toBeTruthy();
  });

  it("does not render interactive elements", () => {
    const { container } = render(<PageShell id="workspace" />);
    expect(container.querySelectorAll("button").length).toBe(0);
    expect(container.querySelectorAll("input").length).toBe(0);
    expect(container.querySelectorAll("form").length).toBe(0);
    expect(container.querySelectorAll("a").length).toBe(0);
  });

  it("does not call fetch", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    render(<PageShell id="workspace" />);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
