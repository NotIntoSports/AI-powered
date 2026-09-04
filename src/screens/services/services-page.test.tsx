import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ServicesPage } from "./services-page";

describe("ServicesPage", () => {
  afterEach(cleanup);

  it("renders the services heading", () => {
    render(<ServicesPage />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("服务");
  });

  it("renders non-empty capabilities", () => {
    render(<ServicesPage />);
    const items = screen.getAllByRole("listitem");
    expect(items.length).toBeGreaterThan(0);
  });

  it("does not call fetch", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    render(<ServicesPage />);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("does not contain /api/ paths", () => {
    const { container } = render(<ServicesPage />);
    expect(container.innerHTML).not.toMatch(/\/api\//);
  });
});
