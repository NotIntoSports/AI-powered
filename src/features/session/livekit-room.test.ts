import { beforeEach, describe, expect, it, vi } from "vitest";

const connect = vi.fn();

vi.mock("livekit-client", () => {
  class Room {
    connect = connect;
  }
  return { Room };
});

import { connectLiveKitRoom } from "./livekit-room";

describe("connectLiveKitRoom", () => {
  beforeEach(() => {
    connect.mockReset();
    connect.mockResolvedValue(undefined);
  });

  it("connects with url and token and does not log the jwt", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const join = {
      url: "wss://livekit.example.test",
      token: "eyJhbGciOiJIUzI1NiJ9.payload.signature",
      room: "session-1",
      identity: "tauri-1",
      expiresInSec: 60,
    };

    const room = await connectLiveKitRoom(join);

    expect(connect).toHaveBeenCalledWith(join.url, join.token);
    expect(room).toBeDefined();
    for (const spy of [log, info, debug, warn, error]) {
      expect(spy.mock.calls.flat().join(" ")).not.toContain(join.token);
      spy.mockRestore();
    }
  });
});
