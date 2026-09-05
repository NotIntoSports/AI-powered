import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as commands from "../../api/commands";
import type { MaterialSearchHit, MaterialSummary } from "../../generated/bindings";
import { MaterialsLibrary } from "./materials-library";

vi.mock("../../api/commands", () => ({
  listMaterials: vi.fn(),
  importMaterial: vi.fn(),
  searchMaterials: vi.fn(),
  deleteMaterial: vi.fn(),
}));

function material(overrides: Partial<MaterialSummary> = {}): MaterialSummary {
  return {
    id: "mat-1",
    fileName: "resume.md",
    contentSha256: "abc123",
    mediaType: "text/markdown",
    byteSize: 128,
    status: "text_ready",
    chunkCount: 3,
    ...overrides,
  };
}

function hit(overrides: Partial<MaterialSearchHit> = {}): MaterialSearchHit {
  return {
    materialId: "mat-1",
    chunkId: "chunk-1",
    fileName: "resume.md",
    section: "经历",
    snippet: "负责订单服务",
    rank: 1,
    ...overrides,
  };
}

describe("MaterialsLibrary", () => {
  beforeEach(() => {
    vi.mocked(commands.listMaterials).mockResolvedValue({ ok: true, data: [] });
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows loading then empty state", async () => {
    render(<MaterialsLibrary />);
    expect(screen.getByRole("status").textContent).toContain("正在读取本地资料");
    expect(await screen.findByText("还没有资料。")).toBeTruthy();
  });

  it("surfaces a load error", async () => {
    vi.mocked(commands.listMaterials).mockResolvedValue({
      ok: false,
      error: { code: "DATABASE_OPERATION_FAILED", message: "数据库不可用", requestId: "r1", field: "database", retryable: true },
    });
    render(<MaterialsLibrary />);
    expect((await screen.findByRole("status")).textContent).toContain("database：DATABASE_OPERATION_FAILED：数据库不可用");
  });

  it("lists fileName, status and chunkCount without document body", async () => {
    vi.mocked(commands.listMaterials).mockResolvedValue({
      ok: true,
      data: [material({ fileName: "resume.md", status: "text_ready", chunkCount: 3 })],
    });
    const { container } = render(<MaterialsLibrary />);
    expect(await screen.findByText("resume.md")).toBeTruthy();
    expect(screen.getByText("text_ready")).toBeTruthy();
    expect(container.textContent).toContain("3");
    expect(container.innerHTML).not.toContain("FULL_EXTRACTED_TEXT");
    expect(container.innerHTML).not.toMatch(/password|apiKey|apiSecret|credential/i);
  });

  it("imports from a path text field", async () => {
    const imported = material();
    vi.mocked(commands.listMaterials)
      .mockResolvedValueOnce({ ok: true, data: [] })
      .mockResolvedValue({ ok: true, data: [imported] });
    vi.mocked(commands.importMaterial).mockResolvedValue({ ok: true, data: imported });

    render(<MaterialsLibrary />);
    await screen.findByText("还没有资料。");
    expect(screen.getByLabelText("文件路径").getAttribute("type")).toBe("text");
    expect(screen.queryByRole("button", { name: "选择文件" })).toBeNull();
    fireEvent.change(screen.getByLabelText("文件路径"), { target: { value: "E:/docs/resume.md" } });
    fireEvent.click(screen.getByRole("button", { name: "导入" }));
    await waitFor(() => expect(commands.importMaterial).toHaveBeenCalledWith("E:/docs/resume.md"));
    expect(await screen.findByText("resume.md")).toBeTruthy();
  });

  it("fills the path from an optional selectPath callback", async () => {
    const selectPath = vi.fn().mockResolvedValue("E:/picked/note.txt");
    render(<MaterialsLibrary selectPath={selectPath} />);
    await screen.findByText("还没有资料。");
    fireEvent.click(screen.getByRole("button", { name: "选择文件" }));
    await waitFor(() => expect(selectPath).toHaveBeenCalled());
    expect((screen.getByLabelText("文件路径") as HTMLInputElement).value).toBe("E:/picked/note.txt");
  });

  it("searches and shows fileName, section and snippet only", async () => {
    vi.mocked(commands.searchMaterials).mockResolvedValue({
      ok: true,
      data: [hit({ fileName: "jd.md", section: "职责", snippet: "维护订单服务" })],
    });
    const { container } = render(<MaterialsLibrary />);
    await screen.findByText("还没有资料。");
    fireEvent.change(screen.getByLabelText("检索词"), { target: { value: "订单服务" } });
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    await waitFor(() => expect(commands.searchMaterials).toHaveBeenCalledWith("订单服务"));
    expect(await screen.findByText("jd.md")).toBeTruthy();
    expect(screen.getByText("职责")).toBeTruthy();
    expect(screen.getByText("维护订单服务")).toBeTruthy();
    expect(container.innerHTML).not.toContain("FULL_EXTRACTED_TEXT");
  });

  it("two-step deletes with cancel and never prompts", async () => {
    vi.mocked(commands.listMaterials)
      .mockResolvedValueOnce({ ok: true, data: [material()] })
      .mockResolvedValue({ ok: true, data: [] });
    vi.mocked(commands.deleteMaterial).mockResolvedValue({ ok: true, data: { ready: true } });
    const promptSpy = vi.spyOn(window, "prompt");
    const confirmSpy = vi.spyOn(window, "confirm");

    render(<MaterialsLibrary />);
    expect(await screen.findByText("resume.md")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(commands.deleteMaterial).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(commands.deleteMaterial).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(commands.deleteMaterial).toHaveBeenCalledWith("mat-1"));
    expect(promptSpy).not.toHaveBeenCalled();
    expect(confirmSpy).not.toHaveBeenCalled();
    promptSpy.mockRestore();
    confirmSpy.mockRestore();
  });

  it("shows import field errors and IPC failures", async () => {
    vi.mocked(commands.importMaterial).mockResolvedValue({
      ok: false,
      error: { code: "MATERIAL_PATH_INVALID", message: "路径无效", requestId: "r2", field: "path", retryable: false },
    });
    render(<MaterialsLibrary />);
    await screen.findByText("还没有资料。");
    fireEvent.change(screen.getByLabelText("文件路径"), { target: { value: "relative.md" } });
    fireEvent.click(screen.getByRole("button", { name: "导入" }));
    expect((await screen.findByRole("status")).textContent).toContain("path：MATERIAL_PATH_INVALID：路径无效");

    vi.mocked(commands.searchMaterials).mockRejectedValue(new Error("ipc"));
    fireEvent.change(screen.getByLabelText("检索词"), { target: { value: "订单" } });
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    expect((await screen.findByRole("status")).textContent).toContain("IPC_UNAVAILABLE：");
  });

  it("does not use fetch, /api/, or low-level Tauri imports", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { container } = render(<MaterialsLibrary />);
    await screen.findByText("还没有资料。");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(container.innerHTML).not.toMatch(/\/api\//);
    expect(container.innerHTML).not.toContain("@tauri-apps/api");
    fetchSpy.mockRestore();
  });
});
