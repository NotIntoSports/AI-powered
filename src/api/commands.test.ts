import { describe, expect, it, vi } from "vitest";

import { invoke } from "@tauri-apps/api/core";

import { getConfigPublic } from "./commands";

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
