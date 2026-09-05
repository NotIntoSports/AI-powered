import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as commands from "../../api/commands";
import { MaterialsPage } from "./materials-page";

vi.mock("../../api/commands", () => ({
  listMaterials: vi.fn(),
  importMaterial: vi.fn(),
  searchMaterials: vi.fn(),
  deleteMaterial: vi.fn(),
}));

describe("MaterialsPage", () => {
  beforeEach(() => {
    vi.mocked(commands.listMaterials).mockResolvedValue({ ok: true, data: [] });
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

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

  it("includes the materials library and drops the leftover placeholder", async () => {
    render(<MaterialsPage />);
    expect(await screen.findByRole("heading", { name: "资料库" })).toBeTruthy();
    expect(screen.queryByText(/尚未接入业务逻辑/)).toBeNull();
  });
});

