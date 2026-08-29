import { afterEach, describe, expect, it, vi } from "vitest";
import { Logger } from "./log.js";
import { OmnigentClient } from "./omnigent.js";

afterEach(() => vi.unstubAllGlobals());

describe("Omnigent API client", () => {
  it("uses the installed server's top-level session kind", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "opaque", expires_in: 3600 }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [], has_more: false }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = new OmnigentClient({
      baseUrl: "https://omnigent.test",
      refreshToken: "opaque-refresh",
      agentName: "default-agent",
      workspace: "/workspace",
      logger: new Logger("error"),
    });

    await expect(client.listSessions()).resolves.toEqual([]);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("kind=default");
  });

  it("renames a session through the installed PATCH contract", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "opaque", expires_in: 3600 }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ id: "session/voice", title: "Audio Packet Research" }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = new OmnigentClient({
      baseUrl: "https://omnigent.test",
      refreshToken: "opaque-refresh",
      agentName: "default-agent",
      workspace: "/workspace",
      logger: new Logger("error"),
    });

    await expect(
      client.renameSession("session/voice", "Audio Packet Research"),
    ).resolves.toMatchObject({ title: "Audio Packet Research" });
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      "https://omnigent.test/v1/sessions/session%2Fvoice",
    );
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: "PATCH",
      body: JSON.stringify({ title: "Audio Packet Research" }),
    });
  });
});
