import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MaterialsPage } from "./materials-page";

describe("MaterialsPage", () => {
  afterEach(cleanup);

  it("renders the materials heading", () => {
    render(<MaterialsPage />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("资料");
  });

  it("renders non-empty capabilities", () => {
    render(<MaterialsPage />);
    const items = screen.getAllByRole("listitem");
    expect(items.length).toBeGreaterThan(0);
  });

  it("does not call fetch", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    render(<MaterialsPage />);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("does not contain /api/ paths", () => {
    const { container } = render(<MaterialsPage />);
    expect(container.innerHTML).not.toMatch(/\/api\//);
  });
});
