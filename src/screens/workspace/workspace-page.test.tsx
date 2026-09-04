import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkspacePage } from "./workspace-page";

describe("WorkspacePage", () => {
  afterEach(cleanup);

  it("renders the workspace heading", () => {
    render(<WorkspacePage />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("工作台");
  });

  it("renders non-empty capabilities", () => {
    render(<WorkspacePage />);
    const items = screen.getAllByRole("listitem");
    expect(items.length).toBeGreaterThan(0);
  });

  it("does not call fetch", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    render(<WorkspacePage />);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("does not contain /api/ paths", () => {
    const { container } = render(<WorkspacePage />);
    expect(container.innerHTML).not.toMatch(/\/api\//);
  });
});
