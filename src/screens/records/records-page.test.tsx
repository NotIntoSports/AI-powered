import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RecordsPage } from "./records-page";

describe("RecordsPage", () => {
  afterEach(cleanup);

  it("renders the records heading", () => {
    render(<RecordsPage />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("记录");
  });

  it("renders non-empty capabilities", () => {
    render(<RecordsPage />);
    const items = screen.getAllByRole("listitem");
    expect(items.length).toBeGreaterThan(0);
  });

  it("does not call fetch", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    render(<RecordsPage />);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("does not contain /api/ paths", () => {
    const { container } = render(<RecordsPage />);
    expect(container.innerHTML).not.toMatch(/\/api\//);
  });
});
