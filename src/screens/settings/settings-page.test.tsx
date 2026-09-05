import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as commands from "../../api/commands";
import { SettingsPage } from "./settings-page";

vi.mock("../../api/commands", () => ({
  getConfigPublic: vi.fn(),
  saveRoleProfile: vi.fn(),
  copyRoleProfile: vi.fn(),
  activateRoleProfile: vi.fn(),
  deleteRoleProfile: vi.fn(),
}));

describe("SettingsPage", () => {
  beforeEach(() => {
    vi.mocked(commands.getConfigPublic).mockResolvedValue({
      ok: true,
      data: {
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
      },
    });
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders the settings heading", () => {
    render(<SettingsPage />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("设置与诊断");
  });

  it("renders non-empty capabilities", () => {
    render(<SettingsPage />);
    const items = screen.getAllByRole("listitem");
    expect(items.length).toBeGreaterThan(0);
  });

  it("does not call fetch", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    render(<SettingsPage />);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("does not contain /api/ paths", () => {
    const { container } = render(<SettingsPage />);
    expect(container.innerHTML).not.toMatch(/\/api\//);
  });

  it("includes the role editor", async () => {
    render(<SettingsPage />);
    expect(await screen.findByRole("heading", { name: "角色" })).toBeTruthy();
  });
});
