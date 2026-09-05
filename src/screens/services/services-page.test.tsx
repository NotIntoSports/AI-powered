import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as commands from "../../api/commands";
import { ServicesPage } from "./services-page";

vi.mock("../../api/commands", () => ({
  getConfigPublic: vi.fn(),
  saveModelProvider: vi.fn(),
  testModelProvider: vi.fn(),
  discoverModelProvider: vi.fn(),
  activateModelProvider: vi.fn(),
  deleteModelProvider: vi.fn(),
  saveSpeechRoute: vi.fn(),
  testSpeechRoute: vi.fn(),
  activateSpeechRoute: vi.fn(),
  deleteSpeechRoute: vi.fn(),
}));

const emptyConfig = {
  configVersion: 1,
  application: { locale: null },
  models: { providers: [], activeProviderId: null },
  speech: { voiceRoutes: [], activeVoiceRouteId: null },
  transport: { livekitUrl: null },
  knowledge: { embeddingProviderId: null },
  storage: { exportDirectory: null },
  roleProfiles: [],
  diagnostics: { logRetentionDays: 14 },
};

describe("ServicesPage", () => {
  beforeEach(() => {
    vi.mocked(commands.getConfigPublic).mockResolvedValue({ ok: true, data: emptyConfig });
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders provider and voice route management", async () => {
    render(<ServicesPage />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("服务");
    expect(await screen.findByRole("heading", { name: "模型供应商" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "语音线路" })).toBeTruthy();
  });

  it("submits a provider key and clears the password field", async () => {
    vi.mocked(commands.saveModelProvider).mockResolvedValue({
      ok: true,
      data: { id: "openai", name: "OpenAI", baseUrl: "https://example.test/v1", credential: { reference: "providers/openai/api-key", configured: true } },
    });
    render(<ServicesPage />);
    await screen.findByRole("heading", { name: "模型供应商" });
    fireEvent.change(screen.getByLabelText("供应商 ID"), { target: { value: "openai" } });
    fireEvent.change(screen.getByLabelText("显示名称"), { target: { value: "OpenAI" } });
    fireEvent.change(screen.getByLabelText("接口基址"), { target: { value: "https://example.test/v1" } });
    const key = screen.getByLabelText(/API Key/) as HTMLInputElement;
    fireEvent.change(key, { target: { value: "secret-marker" } });
    fireEvent.click(screen.getByRole("button", { name: "保存供应商" }));
    await waitFor(() => expect(commands.saveModelProvider).toHaveBeenCalled());
    expect(key.value).toBe("");
    expect(document.body.textContent).not.toContain("secret-marker");
  });

  it("does not call fetch or contain old API paths", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { container } = render(<ServicesPage />);
    await screen.findByRole("heading", { name: "模型供应商" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(container.innerHTML).not.toMatch(/\/api\//);
    fetchSpy.mockRestore();
  });

  it("loads an existing provider into the editor without exposing its key", async () => {
    vi.mocked(commands.getConfigPublic).mockResolvedValue({
      ok: true,
      data: {
        ...emptyConfig,
        models: { providers: [{ id: "openai", name: "OpenAI", baseUrl: "https://example.test/v1", credential: { reference: "providers/openai/api-key", configured: true } }], activeProviderId: null },
      },
    });
    render(<ServicesPage />);
    fireEvent.click(await screen.findByRole("button", { name: "编辑 OpenAI" }));
    expect((screen.getByLabelText("供应商 ID") as HTMLInputElement).value).toBe("openai");
    expect((screen.getByLabelText(/API Key/) as HTMLInputElement).value).toBe("");
  });

  it("offers discovered models to voice route fields", async () => {
    vi.mocked(commands.getConfigPublic).mockResolvedValue({
      ok: true,
      data: { ...emptyConfig, models: { providers: [{ id: "openai", name: "OpenAI", baseUrl: "https://example.test/v1", credential: null }], activeProviderId: null } },
    });
    vi.mocked(commands.discoverModelProvider).mockResolvedValue({
      ok: true,
      data: { providerId: "openai", models: [{ id: "model-a" }] },
    });
    const { container } = render(<ServicesPage />);
    fireEvent.click(await screen.findByRole("button", { name: "发现模型" }));
    fireEvent.change(screen.getByLabelText("ASR 供应商"), { target: { value: "openai" } });
    await waitFor(() => expect(container.querySelector('#models-asr option[value="model-a"]')).not.toBeNull());
    expect((screen.getByLabelText("ASR 模型") as HTMLInputElement).getAttribute("list")).toBe("models-asr");
  });
});
