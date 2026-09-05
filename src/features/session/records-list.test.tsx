import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as commands from "../../api/commands";
import type { SessionDetail, SessionSummary, SessionTurnView } from "../../generated/bindings";
import { RecordsList } from "./records-list";

vi.mock("../../api/commands", () => ({
  listSessions: vi.fn(),
  getSession: vi.fn(),
  exportSession: vi.fn(),
  deleteSession: vi.fn(),
}));

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "sess-1",
    status: "completed",
    roleProfileId: "role-1",
    voiceRouteId: "route-1",
    transportMode: "direct",
    startedAt: "2026-09-05T10:00:00Z",
    finishedAt: "2026-09-05T10:05:00Z",
    updatedAt: "2026-09-05T10:05:00Z",
    ...overrides,
  };
}

function turn(overrides: Partial<SessionTurnView> = {}): SessionTurnView {
  return {
    id: "turn-1",
    turnIndex: 0,
    userText: "请介绍岗位",
    assistantText: "这是一个后端岗位",
    materialsUsed: false,
    citations: [{ materialId: "mat-1", chunkId: "chunk-1", snippet: "负责订单服务" }],
    ...overrides,
  };
}

function detail(overrides: Partial<SessionDetail> = {}): SessionDetail {
  return {
    session: summary(),
    turns: [turn()],
    ...overrides,
  };
}

describe("RecordsList", () => {
  beforeEach(() => {
    vi.mocked(commands.listSessions).mockResolvedValue({ ok: true, data: [] });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows loading then empty state", async () => {
    render(<RecordsList />);
    expect(screen.getByRole("status").textContent).toContain("正在读取会话记录");
    expect(await screen.findByText("还没有记录。")).toBeTruthy();
  });

  it("surfaces a load error", async () => {
    vi.mocked(commands.listSessions).mockResolvedValue({
      ok: false,
      error: {
        code: "DATABASE_OPERATION_FAILED",
        message: "数据库不可用",
        requestId: "r1",
        field: "database",
        retryable: true,
      },
    });
    render(<RecordsList />);
    expect((await screen.findByRole("status")).textContent).toContain(
      "database：DATABASE_OPERATION_FAILED：数据库不可用",
    );
  });

  it("lists session id and status then opens turn detail", async () => {
    vi.mocked(commands.listSessions).mockResolvedValue({ ok: true, data: [summary()] });
    vi.mocked(commands.getSession).mockResolvedValue({ ok: true, data: detail() });

    const { container } = render(<RecordsList />);
    expect(await screen.findByText("sess-1")).toBeTruthy();
    expect(container.textContent).toContain("completed");
    fireEvent.click(screen.getByRole("button", { name: "查看" }));
    await waitFor(() => expect(commands.getSession).toHaveBeenCalledWith("sess-1"));
    expect(document.body.textContent).toContain("请介绍岗位");
    expect(document.body.textContent).toContain("这是一个后端岗位");
    expect(document.body.textContent).toContain("负责订单服务");
    expect(document.body.textContent).toContain("本轮未使用资料");
    expect(container.innerHTML).not.toMatch(/password|apiKey|apiSecret|credential/i);
  });

  it("exports markdown json and text", async () => {
    vi.mocked(commands.listSessions).mockResolvedValue({ ok: true, data: [summary()] });
    vi.mocked(commands.getSession).mockResolvedValue({ ok: true, data: detail() });
    vi.mocked(commands.exportSession).mockResolvedValue({
      ok: true,
      data: { path: "C:/data/exports/sess-1.md" },
    });

    render(<RecordsList />);
    fireEvent.click(await screen.findByRole("button", { name: "查看" }));
    await screen.findByText("请介绍岗位");
    fireEvent.click(screen.getByRole("button", { name: "导出 Markdown" }));
    await waitFor(() => expect(commands.exportSession).toHaveBeenCalledWith("sess-1", "markdown"));
    expect(screen.getByRole("status").textContent).toContain("C:/data/exports/sess-1.md");

    vi.mocked(commands.exportSession).mockResolvedValue({
      ok: true,
      data: { path: "C:/data/exports/sess-1.json" },
    });
    fireEvent.click(screen.getByRole("button", { name: "导出 JSON" }));
    await waitFor(() => expect(commands.exportSession).toHaveBeenCalledWith("sess-1", "json"));

    vi.mocked(commands.exportSession).mockResolvedValue({
      ok: true,
      data: { path: "C:/data/exports/sess-1.txt" },
    });
    fireEvent.click(screen.getByRole("button", { name: "导出文本" }));
    await waitFor(() => expect(commands.exportSession).toHaveBeenCalledWith("sess-1", "text"));
  });

  it("two-step deletes with cancel and never prompts", async () => {
    vi.mocked(commands.listSessions)
      .mockResolvedValueOnce({ ok: true, data: [summary()] })
      .mockResolvedValue({ ok: true, data: [] });
    vi.mocked(commands.deleteSession).mockResolvedValue({ ok: true, data: { ready: true } });
    const promptSpy = vi.spyOn(window, "prompt");
    const confirmSpy = vi.spyOn(window, "confirm");

    render(<RecordsList />);
    expect(await screen.findByText("sess-1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(commands.deleteSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(commands.deleteSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(commands.deleteSession).toHaveBeenCalledWith("sess-1"));
    expect(promptSpy).not.toHaveBeenCalled();
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(await screen.findByText("还没有记录。")).toBeTruthy();
    promptSpy.mockRestore();
    confirmSpy.mockRestore();
  });

  it("shows export field errors and IPC failures", async () => {
    vi.mocked(commands.listSessions).mockResolvedValue({ ok: true, data: [summary()] });
    vi.mocked(commands.getSession).mockResolvedValue({ ok: true, data: detail() });
    vi.mocked(commands.exportSession).mockResolvedValue({
      ok: false,
      error: {
        code: "SESSION_EXPORT_FORMAT_INVALID",
        message: "格式无效",
        requestId: "r2",
        field: "format",
        retryable: false,
      },
    });

    render(<RecordsList />);
    fireEvent.click(await screen.findByRole("button", { name: "查看" }));
    await screen.findByText("请介绍岗位");
    fireEvent.click(screen.getByRole("button", { name: "导出 Markdown" }));
    expect((await screen.findByRole("status")).textContent).toContain(
      "format：SESSION_EXPORT_FORMAT_INVALID：格式无效",
    );

    vi.mocked(commands.exportSession).mockRejectedValue(new Error("ipc"));
    fireEvent.click(screen.getByRole("button", { name: "导出 JSON" }));
    expect((await screen.findByRole("status")).textContent).toContain("IPC_UNAVAILABLE：");
  });

  it("does not use fetch, /api/, or low-level Tauri imports", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { container } = render(<RecordsList />);
    await screen.findByText("还没有记录。");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(container.innerHTML).not.toMatch(/\/api\//);
    expect(container.innerHTML).not.toContain("@tauri-apps/api");
    fetchSpy.mockRestore();
  });
});
