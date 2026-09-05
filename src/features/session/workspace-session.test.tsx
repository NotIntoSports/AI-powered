import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as commands from "../../api/commands";
import type {
  RuntimeStatus,
  SessionDetail,
  SessionReplyEvent,
  SessionSummary,
  SessionTranscriptEvent,
  SessionTurnView,
} from "../../generated/bindings";
import { WorkspaceSession } from "./workspace-session";

vi.mock("../../api/commands", () => ({
  startSession: vi.fn(),
  stopSession: vi.fn(),
  setSessionMode: vi.fn(),
  getRuntimeStatus: vi.fn(),
  getSession: vi.fn(),
  finalizeSessionUtterance: vi.fn(),
}));

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "sess-1",
    status: "listening",
    roleProfileId: "role-1",
    voiceRouteId: "route-1",
    transportMode: "direct",
    startedAt: "2026-09-05T10:00:00Z",
    finishedAt: null,
    updatedAt: "2026-09-05T10:00:00Z",
    ...overrides,
  };
}

function status(overrides: Partial<RuntimeStatus> = {}): RuntimeStatus {
  return {
    phase: "idle",
    mode: "ai_active",
    seq: 1,
    unusedMaterials: false,
    lastErrorCode: null,
    ...overrides,
  };
}

function turn(overrides: Partial<SessionTurnView> = {}): SessionTurnView {
  return {
    id: "turn-1",
    turnIndex: 0,
    userText: "请介绍岗位",
    assistantText: "这是一个后端岗位",
    materialsUsed: true,
    citations: [],
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

describe("WorkspaceSession", () => {
  beforeEach(() => {
    vi.mocked(commands.getRuntimeStatus).mockResolvedValue({ ok: true, data: status() });
    vi.mocked(commands.startSession).mockResolvedValue({
      ok: true,
      data: { kind: "started", session: summary(), livekit: null },
    });
    vi.mocked(commands.stopSession).mockResolvedValue({
      ok: true,
      data: summary({ status: "completed", finishedAt: "2026-09-05T10:05:00Z" }),
    });
    vi.mocked(commands.setSessionMode).mockResolvedValue({
      ok: true,
      data: status({ mode: "operator_speaking", phase: "listening", seq: 2 }),
    });
    vi.mocked(commands.getSession).mockResolvedValue({
      ok: true,
      data: { session: summary(), turns: [] },
    });
    vi.mocked(commands.finalizeSessionUtterance).mockResolvedValue({
      ok: true,
      data: turn(),
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows loading then idle start controls", async () => {
    render(<WorkspaceSession />);
    expect(screen.getByRole("status").textContent).toContain("正在读取会话状态");
    expect(await screen.findByRole("button", { name: "开始" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "停止" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("heading", { name: "当前会话" })).toBeTruthy();
    expect(document.body.textContent).toContain("idle");
  });

  it("starts a session and shows the listening phase", async () => {
    vi.mocked(commands.getRuntimeStatus)
      .mockResolvedValueOnce({ ok: true, data: status() })
      .mockResolvedValue({ ok: true, data: status({ phase: "listening", seq: 2 }) });

    render(<WorkspaceSession />);
    fireEvent.click(await screen.findByRole("button", { name: "开始" }));
    await waitFor(() => expect(document.body.textContent).toContain("listening"));
    expect(commands.startSession).toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "开始" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "停止" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("surfaces blocked preflight issues and start field errors", async () => {
    vi.mocked(commands.startSession).mockResolvedValueOnce({
      ok: true,
      data: {
        kind: "blocked",
        issues: [
          { code: "SESSION_ROUTE_REQUIRED", area: "speech", action: "open_services" },
          { code: "SESSION_ROLE_REQUIRED", area: "role", action: "open_services" },
        ],
      },
    });
    render(<WorkspaceSession />);
    fireEvent.click(await screen.findByRole("button", { name: "开始" }));
    expect((await screen.findByRole("status")).textContent).toContain(
      "speech：SESSION_ROUTE_REQUIRED：open_services",
    );
    expect(screen.getByRole("status").textContent).toContain("role：SESSION_ROLE_REQUIRED：open_services");

    vi.mocked(commands.startSession).mockResolvedValueOnce({
      ok: false,
      error: {
        code: "SESSION_ALREADY_ACTIVE",
        message: "会话已在进行",
        requestId: "r1",
        field: "session",
        retryable: false,
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "开始" }));
    expect((await screen.findByRole("status")).textContent).toContain(
      "session：SESSION_ALREADY_ACTIVE：会话已在进行",
    );
  });

  it("stops the session and returns to a completed phase", async () => {
    vi.mocked(commands.getRuntimeStatus)
      .mockResolvedValueOnce({ ok: true, data: status({ phase: "listening", seq: 2 }) })
      .mockResolvedValue({ ok: true, data: status({ phase: "completed", seq: 3 }) });

    render(<WorkspaceSession />);
    await screen.findByText(/listening/);
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    await waitFor(() => expect(commands.stopSession).toHaveBeenCalled());
    expect(document.body.textContent).toContain("completed");
  });

  it("takeover switches 接管 / 恢复 AI / 静音 without prompting", async () => {
    vi.mocked(commands.getRuntimeStatus).mockResolvedValue({
      ok: true,
      data: status({ phase: "listening", seq: 2 }),
    });
    const promptSpy = vi.spyOn(window, "prompt");
    const confirmSpy = vi.spyOn(window, "confirm");

    render(<WorkspaceSession />);
    await screen.findByText(/listening/);
    fireEvent.click(screen.getByRole("button", { name: "接管" }));
    await waitFor(() => expect(commands.setSessionMode).toHaveBeenCalledWith("operator_speaking"));
    fireEvent.click(screen.getByRole("button", { name: "恢复 AI" }));
    await waitFor(() => expect(commands.setSessionMode).toHaveBeenCalledWith("ai_active"));
    fireEvent.click(screen.getByRole("button", { name: "静音" }));
    await waitFor(() => expect(commands.setSessionMode).toHaveBeenCalledWith("muted"));
    expect(promptSpy).not.toHaveBeenCalled();
    expect(confirmSpy).not.toHaveBeenCalled();
    promptSpy.mockRestore();
    confirmSpy.mockRestore();
  });

  it("default finalize hook calls session_finalize_utterance then renders reply", async () => {
    vi.mocked(commands.finalizeSessionUtterance).mockImplementation(async () => {
      vi.mocked(commands.getSession).mockResolvedValue({ ok: true, data: detail() });
      vi.mocked(commands.getRuntimeStatus).mockResolvedValue({
        ok: true,
        data: status({ phase: "listening", unusedMaterials: false, seq: 4 }),
      });
      return { ok: true, data: turn() };
    });

    render(<WorkspaceSession />);
    fireEvent.click(await screen.findByRole("button", { name: "开始" }));
    await waitFor(() => expect(document.body.textContent).toContain("listening"));
    fireEvent.change(screen.getByLabelText("测试语句"), { target: { value: "请介绍岗位" } });
    fireEvent.click(screen.getByRole("button", { name: "提交语句" }));
    await waitFor(() => expect(commands.finalizeSessionUtterance).toHaveBeenCalledWith("请介绍岗位"));
    expect(document.body.textContent).toContain("请介绍岗位");
    expect(document.body.textContent).toContain("这是一个后端岗位");
    expect(document.body.textContent).not.toContain("本轮未使用资料");
  });

  it("keeps 停止 and 接管 enabled while finalize is in flight", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(commands.finalizeSessionUtterance).mockImplementation(async () => {
      await blocked;
      return { ok: true, data: turn() };
    });
    vi.mocked(commands.getRuntimeStatus).mockResolvedValue({
      ok: true,
      data: status({ phase: "listening", seq: 2 }),
    });

    render(<WorkspaceSession />);
    fireEvent.click(await screen.findByRole("button", { name: "开始" }));
    await waitFor(() => expect(document.body.textContent).toContain("listening"));
    fireEvent.change(screen.getByLabelText("测试语句"), { target: { value: "慢轮" } });
    fireEvent.click(screen.getByRole("button", { name: "提交语句" }));
    await waitFor(() => {
      expect((screen.getByRole("button", { name: "提交语句" }) as HTMLButtonElement).disabled).toBe(
        true,
      );
    });
    expect((screen.getByRole("button", { name: "停止" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "接管" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "开始" }) as HTMLButtonElement).disabled).toBe(true);
    release();
    await waitFor(() => expect(commands.finalizeSessionUtterance).toHaveBeenCalledWith("慢轮"));
  });

  it("shows 本轮未使用资料 after finalize when materials_used is false", async () => {
    vi.mocked(commands.finalizeSessionUtterance).mockImplementation(async () => {
      vi.mocked(commands.getSession).mockResolvedValue({
        ok: true,
        data: detail({ turns: [turn({ materialsUsed: false })] }),
      });
      vi.mocked(commands.getRuntimeStatus).mockResolvedValue({
        ok: true,
        data: status({ phase: "listening", unusedMaterials: true, seq: 5 }),
      });
      return { ok: true, data: turn({ materialsUsed: false }) };
    });

    render(<WorkspaceSession />);
    fireEvent.click(await screen.findByRole("button", { name: "开始" }));
    await waitFor(() => expect(document.body.textContent).toContain("listening"));
    fireEvent.change(screen.getByLabelText("测试语句"), { target: { value: "你好" } });
    fireEvent.click(screen.getByRole("button", { name: "提交语句" }));
    expect((await screen.findByText("本轮未使用资料")).textContent).toBe("本轮未使用资料");
    expect(commands.finalizeSessionUtterance).toHaveBeenCalledWith("你好");
  });

  it("clears previous turn text when a new session starts", async () => {
    vi.mocked(commands.getRuntimeStatus)
      .mockResolvedValueOnce({ ok: true, data: status() })
      .mockResolvedValue({ ok: true, data: status({ phase: "listening", seq: 2 }) });
    vi.mocked(commands.finalizeSessionUtterance).mockImplementation(async () => {
      vi.mocked(commands.getSession).mockResolvedValue({ ok: true, data: detail() });
      vi.mocked(commands.getRuntimeStatus).mockResolvedValue({
        ok: true,
        data: status({ phase: "listening", unusedMaterials: false, seq: 4 }),
      });
      return { ok: true, data: turn() };
    });

    render(<WorkspaceSession />);
    fireEvent.click(await screen.findByRole("button", { name: "开始" }));
    await waitFor(() => expect(document.body.textContent).toContain("listening"));
    fireEvent.change(screen.getByLabelText("测试语句"), { target: { value: "请介绍岗位" } });
    fireEvent.click(screen.getByRole("button", { name: "提交语句" }));
    await waitFor(() => expect(document.body.textContent).toContain("这是一个后端岗位"));

    vi.mocked(commands.getRuntimeStatus).mockResolvedValue({
      ok: true,
      data: status({ phase: "completed", seq: 5 }),
    });
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    await waitFor(() => expect(document.body.textContent).toContain("completed"));

    vi.mocked(commands.getSession).mockResolvedValue({
      ok: true,
      data: { session: summary({ id: "sess-2" }), turns: [] },
    });
    vi.mocked(commands.startSession).mockResolvedValue({
      ok: true,
      data: { kind: "started", session: summary({ id: "sess-2" }), livekit: null },
    });
    fireEvent.click(screen.getByRole("button", { name: "开始" }));
    await waitFor(() => {
      expect(commands.startSession).toHaveBeenCalledTimes(2);
      expect(document.body.textContent).not.toContain("转写");
      expect(document.body.textContent).not.toContain("这是一个后端岗位");
      expect((screen.getByLabelText("测试语句") as HTMLInputElement).value).toBe("");
    });
  });

  it("applies live events and drops stale seq per topic", async () => {
    const listeners: {
      status?: (payload: RuntimeStatus) => void;
      transcript?: (payload: SessionTranscriptEvent) => void;
      reply?: (payload: SessionReplyEvent) => void;
    } = {};
    const listen = vi.fn(async (event: string, handler: (payload: never) => void) => {
      if (event === "runtime.status.v1") listeners.status = handler as (payload: RuntimeStatus) => void;
      if (event === "session.transcript.v1") {
        listeners.transcript = handler as (payload: SessionTranscriptEvent) => void;
      }
      if (event === "session.reply.v1") listeners.reply = handler as (payload: SessionReplyEvent) => void;
      return () => {};
    });

    render(<WorkspaceSession listen={listen} />);
    await waitFor(() => expect(listen).toHaveBeenCalledTimes(3));

    act(() => {
      listeners.status?.({ phase: "thinking", mode: "ai_active", seq: 3, unusedMaterials: false, lastErrorCode: null });
    });
    expect(document.body.textContent).toContain("thinking");
    act(() => {
      listeners.status?.({ phase: "idle", mode: "ai_active", seq: 2, unusedMaterials: false, lastErrorCode: null });
    });
    expect(document.body.textContent).toContain("thinking");
    expect(document.body.textContent).not.toMatch(/idle/);

    act(() => {
      listeners.transcript?.({ seq: 4, text: "新转写" });
    });
    expect(document.body.textContent).toContain("新转写");
    act(() => {
      listeners.transcript?.({ seq: 1, text: "旧转写" });
    });
    expect(document.body.textContent).toContain("新转写");
    expect(document.body.textContent).not.toContain("旧转写");

    act(() => {
      listeners.reply?.({ seq: 5, text: "新回复" });
    });
    expect(document.body.textContent).toContain("新回复");
    act(() => {
      listeners.reply?.({ seq: 2, text: "旧回复" });
    });
    expect(document.body.textContent).toContain("新回复");
    expect(document.body.textContent).not.toContain("旧回复");
  });

  it("shows IPC failures and never uses fetch or meeting-bridge copy", async () => {
    vi.mocked(commands.startSession).mockRejectedValue(new Error("ipc"));
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { container } = render(<WorkspaceSession />);
    fireEvent.click(await screen.findByRole("button", { name: "开始" }));
    expect((await screen.findByRole("status")).textContent).toContain("IPC_UNAVAILABLE：");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(container.innerHTML).not.toMatch(/\/api\//);
    expect(container.innerHTML).not.toContain("@tauri-apps/api");
    expect(container.textContent).not.toContain("会议桥接");
    fetchSpy.mockRestore();
  });
});
