import { describe, expect, it, vi } from "vitest";

import { invoke } from "@tauri-apps/api/core";

import {
  activateModelProvider,
  activateSpeechRoute,
  deleteModelProvider,
  deleteSpeechRoute,
  discoverModelProvider,
  getConfigPublic,
  saveModelProvider,
  saveSpeechRoute,
  testModelProvider,
  testSpeechRoute,
} from "./commands";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);

describe("getConfigPublic adapter", () => {
  it("invokes config_get_public with no arguments", async () => {
    invokeMock.mockResolvedValue({ ok: true, data: { configVersion: 1 } });

    const result = await getConfigPublic();

    expect(invokeMock).toHaveBeenCalledWith("config_get_public");
    expect(result).toEqual({ ok: true, data: { configVersion: 1 } });
  });

  it("surfaces a redacted public config that never carries secret values", async () => {
    // The Rust contract only ever returns SecretSlot references, never values.
    const data = {
      configVersion: 1,
      models: {
        providers: [
          { id: "p1", name: null, baseUrl: "https://one.example", credential: { reference: "providers/p1/api-key", configured: true } },
        ],
        activeProviderId: "p1",
      },
    };
    invokeMock.mockResolvedValue({ ok: true, data });

    const result = await getConfigPublic();
    const serialized = JSON.stringify(result).toLowerCase();

    expect(result).toEqual({ ok: true, data });
    expect(serialized).toContain("providers/p1/api-key");
    for (const needle of ["apikey", "password", "secretvalue", "secretcontents", "token"]) {
      expect(serialized).not.toContain(needle);
    }
  });
});

describe("Phase 3 service adapters", () => {
  it("uses exact provider command names and payloads", async () => {
    invokeMock.mockResolvedValue({ ok: true, data: {} });
    const input = { id: "openai", name: "OpenAI", baseUrl: "https://example.test/v1", apiKey: "value" };
    await saveModelProvider(input);
    await testModelProvider("openai");
    await discoverModelProvider("openai");
    await activateModelProvider("openai");
    await deleteModelProvider("openai");
    expect(invokeMock).toHaveBeenNthCalledWith(1, "model_provider_save", { input });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "model_provider_test", { providerId: "openai" });
    expect(invokeMock).toHaveBeenNthCalledWith(3, "model_provider_discover", { providerId: "openai" });
    expect(invokeMock).toHaveBeenNthCalledWith(4, "model_provider_activate", { providerId: "openai" });
    expect(invokeMock).toHaveBeenNthCalledWith(5, "model_provider_delete", { providerId: "openai" });
  });

  it("uses exact voice route command names", async () => {
    invokeMock.mockResolvedValue({ ok: true, data: {} });
    const input = { id: "route", name: "Route", mode: "e2e" as const, asrProviderId: null, asrModelId: null, llmProviderId: null, llmModelId: null, ttsProviderId: null, ttsModelId: null, voiceId: null, e2eProviderId: "openai", e2eModelId: "realtime" };
    await saveSpeechRoute(input);
    await testSpeechRoute("route");
    await activateSpeechRoute("route");
    await deleteSpeechRoute("route");
    expect(invokeMock).toHaveBeenNthCalledWith(1, "speech_route_save", { input });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "speech_route_test", { routeId: "route" });
    expect(invokeMock).toHaveBeenNthCalledWith(3, "speech_route_activate", { routeId: "route" });
    expect(invokeMock).toHaveBeenNthCalledWith(4, "speech_route_delete", { routeId: "route" });
  });
});
