import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as commands from "../../api/commands";
import type { PublicConfig } from "../../generated/bindings";
import { LiveKitEditor } from "./livekit-editor";

vi.mock("../../api/commands", () => ({
  getConfigPublic: vi.fn(),
  saveLiveKitSettings: vi.fn(),
  testLiveKitSettings: vi.fn(),
  enableLiveKitSettings: vi.fn(),
}));

const emptyConfig: PublicConfig = {
  configVersion: 1,
  application: { locale: null },
  models: { providers: [], activeProviderId: null },
  speech: { voiceRoutes: [], activeVoiceRouteId: null },
  transport: {
    livekit: { enabled: false, url: null, apiKey: null, apiSecret: null, ready: false, status: null, configVersion: 0 },
  },
  knowledge: { embeddingConfigs: [], activeEmbeddingConfigId: null },
  storage: { exportDirectory: null },
  roleProfiles: [],
  activeRoleProfileId: null,
  diagnostics: { logRetentionDays: 14 },
};

describe("LiveKitEditor", () => {
  beforeEach(() => {
    vi.mocked(commands.getConfigPublic).mockResolvedValue({ ok: true, data: emptyConfig });
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("starts disabled, preserves blanks, clears secrets, and gates enable on test", async () => {
    const saved = {
      ...emptyConfig.transport.livekit,
      url: "wss://livekit.example.test",
      apiKey: { reference: "transport/livekit/api-key", configured: true },
      apiSecret: { reference: "transport/livekit/api-secret", configured: true },
      configVersion: 1,
    };
    const ready = { ...saved, ready: true, status: "ready" };
    vi.mocked(commands.getConfigPublic)
      .mockResolvedValueOnce({ ok: true, data: emptyConfig })
      .mockResolvedValueOnce({ ok: true, data: { ...emptyConfig, transport: { livekit: saved } } })
      .mockResolvedValue({ ok: true, data: { ...emptyConfig, transport: { livekit: ready } } });
    vi.mocked(commands.saveLiveKitSettings).mockResolvedValue({ ok: true, data: saved });
    vi.mocked(commands.testLiveKitSettings).mockResolvedValue({ ok: true, data: { ready: true } });
    vi.mocked(commands.enableLiveKitSettings).mockResolvedValue({ ok: true, data: { ...ready, enabled: true } });

    render(<LiveKitEditor />);
    expect(await screen.findByText(/默认关闭。媒体只会在以后明确使用 LiveKit/)).toBeTruthy();
    expect(screen.getByText(/媒体只会在以后明确使用 LiveKit 时发送到该服务/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("服务 URL"), { target: { value: "wss://livekit.example.test" } });
    const key = screen.getByLabelText(/API Key/) as HTMLInputElement;
    const secret = screen.getByLabelText(/API Secret/) as HTMLInputElement;
    fireEvent.change(key, { target: { value: "transient-key" } });
    fireEvent.change(secret, { target: { value: "transient-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "保存 LiveKit" }));
    await waitFor(() =>
      expect(commands.saveLiveKitSettings).toHaveBeenCalledWith({
        url: "wss://livekit.example.test",
        apiKey: "transient-key",
        apiSecret: "transient-secret",
      }),
    );
    expect(key.value).toBe("");
    expect(secret.value).toBe("");
    expect(document.body.textContent).not.toContain("transient-key");
    expect(document.body.textContent).not.toContain("transient-secret");
    expect(screen.getByText("密钥：已安全保存")).toBeTruthy();
    expect((screen.getByRole("button", { name: "启用" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "测试" }));
    await waitFor(() => expect(commands.testLiveKitSettings).toHaveBeenCalled());
    await waitFor(() => expect((screen.getByRole("button", { name: "启用" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "启用" }));
    await waitFor(() => expect(commands.enableLiveKitSettings).toHaveBeenCalledWith(true));
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(commands.enableLiveKitSettings).toHaveBeenCalledWith(false));
  });

  it("sends null secrets when left blank and surfaces IPC rejection", async () => {
    vi.mocked(commands.getConfigPublic).mockResolvedValue({
      ok: true,
      data: {
        ...emptyConfig,
        transport: {
          livekit: {
            enabled: false,
            url: "wss://livekit.example.test",
            apiKey: { reference: "transport/livekit/api-key", configured: true },
            apiSecret: { reference: "transport/livekit/api-secret", configured: true },
            ready: false,
            status: "not_tested",
            configVersion: 1,
          },
        },
      },
    });
    vi.mocked(commands.saveLiveKitSettings).mockResolvedValue({
      ok: false,
      error: { code: "CONFIG_URL_INVALID", message: "URL 无效", requestId: "l1", field: "url", retryable: false },
    });
    render(<LiveKitEditor />);
    await screen.findByText("密钥：已安全保存");
    fireEvent.click(screen.getByRole("button", { name: "保存 LiveKit" }));
    await waitFor(() =>
      expect(commands.saveLiveKitSettings).toHaveBeenCalledWith({
        url: "wss://livekit.example.test",
        apiKey: null,
        apiSecret: null,
      }),
    );
    expect((await screen.findByRole("status")).textContent).toContain("url：CONFIG_URL_INVALID");
  });
});
