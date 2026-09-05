import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as commands from "../../api/commands";
import type { EmbeddingConfig, PublicConfig } from "../../generated/bindings";
import { EmbeddingEditor } from "./embedding-editor";

vi.mock("../../api/commands", () => ({
  getConfigPublic: vi.fn(),
  saveEmbeddingConfig: vi.fn(),
  testEmbeddingConfig: vi.fn(),
  activateEmbeddingConfig: vi.fn(),
  deleteEmbeddingConfig: vi.fn(),
}));

const emptyConfig: PublicConfig = {
  configVersion: 1,
  application: { locale: null },
  models: {
    providers: [{ id: "openai", name: "OpenAI", baseUrl: "https://example.test/v1", credential: { reference: "providers/openai/api-key", configured: true } }],
    activeProviderId: "openai",
  },
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

function embedding(overrides: Partial<EmbeddingConfig> = {}): EmbeddingConfig {
  return {
    id: "primary",
    providerId: "openai",
    modelId: "embed-3",
    dimensions: 8,
    distance: "cosine",
    normalized: true,
    active: false,
    ready: false,
    status: "not_tested",
    configVersion: 1,
    ...overrides,
  };
}

describe("EmbeddingEditor", () => {
  beforeEach(() => {
    vi.mocked(commands.getConfigPublic).mockResolvedValue({ ok: true, data: emptyConfig });
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("saves provider model and dimensions then gates activation on test", async () => {
    const saved = embedding();
    const ready = embedding({ ready: true, status: "ready" });
    vi.mocked(commands.getConfigPublic)
      .mockResolvedValueOnce({ ok: true, data: emptyConfig })
      .mockResolvedValueOnce({ ok: true, data: { ...emptyConfig, knowledge: { embeddingConfigs: [saved], activeEmbeddingConfigId: null } } })
      .mockResolvedValue({ ok: true, data: { ...emptyConfig, knowledge: { embeddingConfigs: [ready], activeEmbeddingConfigId: null } } });
    vi.mocked(commands.saveEmbeddingConfig).mockResolvedValue({ ok: true, data: saved });
    vi.mocked(commands.testEmbeddingConfig).mockResolvedValue({ ok: true, data: { id: "primary", ready: true, dimensions: 8 } });
    vi.mocked(commands.activateEmbeddingConfig).mockResolvedValue({ ok: true, data: { ...ready, active: true } });

    render(<EmbeddingEditor />);
    expect(await screen.findByText(/测试、切片和查询文本会发送到所选供应商/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("配置 ID"), { target: { value: "primary" } });
    fireEvent.change(screen.getByLabelText("供应商"), { target: { value: "openai" } });
    fireEvent.change(screen.getByLabelText("模型"), { target: { value: "embed-3" } });
    fireEvent.change(screen.getByLabelText("维度"), { target: { value: "8" } });
    expect(screen.getByLabelText("维度").getAttribute("min")).toBe("1");
    expect(screen.getByLabelText("维度").getAttribute("max")).toBe("65536");
    expect((screen.getByLabelText("距离") as HTMLInputElement).value).toBe("cosine");
    fireEvent.click(screen.getByRole("button", { name: "保存 Embedding" }));
    await waitFor(() =>
      expect(commands.saveEmbeddingConfig).toHaveBeenCalledWith({
        id: "primary",
        providerId: "openai",
        modelId: "embed-3",
        dimensions: 8,
        normalized: true,
      }),
    );
    const enable = await screen.findByRole("button", { name: "启用" });
    expect((enable as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "测试" }));
    await waitFor(() => expect(commands.testEmbeddingConfig).toHaveBeenCalledWith("primary"));
    await waitFor(() => expect((screen.getByRole("button", { name: "启用" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "启用" }));
    await waitFor(() => expect(commands.activateEmbeddingConfig).toHaveBeenCalledWith("primary"));
  });

  it("disables after a failed retest and can delete", async () => {
    const failed = embedding({ ready: false, status: "test_failed", active: false });
    vi.mocked(commands.getConfigPublic).mockResolvedValue({
      ok: true,
      data: { ...emptyConfig, knowledge: { embeddingConfigs: [failed], activeEmbeddingConfigId: null } },
    });
    vi.mocked(commands.testEmbeddingConfig).mockResolvedValue({
      ok: false,
      error: { code: "EMBEDDING_UNAUTHORIZED", message: "未授权", requestId: "e1", retryable: false },
    });
    vi.mocked(commands.deleteEmbeddingConfig).mockResolvedValue({ ok: true, data: { ready: true } });
    render(<EmbeddingEditor />);
    expect((await screen.findByRole("button", { name: "启用" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "测试" }));
    expect((await screen.findByRole("status")).textContent).toContain("EMBEDDING_UNAUTHORIZED");
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(() => expect(commands.deleteEmbeddingConfig).toHaveBeenCalledWith("primary"));
  });
});
