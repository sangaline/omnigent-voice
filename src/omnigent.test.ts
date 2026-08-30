import { afterEach, describe, expect, it, vi } from "vitest";
import { Logger } from "./log.js";
import { OmnigentClient } from "./omnigent.js";

afterEach(() => vi.unstubAllGlobals());

describe("Omnigent API client", () => {
  it("parses the authenticated live session SSE stream", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "opaque", expires_in: 3600 }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          [
            "event: session.heartbeat",
            'data: {"type":"session.heartbeat"}',
            "",
            "event: response.output_text.delta",
            'data: {"type":"response.output_text.delta","delta":"Ready.","message_id":"msg-1","index":0,"final":true}',
            "",
            "data: [DONE]",
            "",
          ].join("\n"),
          { status: 200, headers: { "content-type": "text/event-stream" } },
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
    const controller = new AbortController();
    const events: Array<Record<string, unknown>> = [];
    const connected = vi.fn();

    await client.streamSession(
      "session/voice",
      controller.signal,
      (event) => {
        events.push(event);
      },
      connected,
    );

    expect(connected).toHaveBeenCalledOnce();
    expect(events).toEqual([
      { type: "session.heartbeat" },
      {
        type: "response.output_text.delta",
        delta: "Ready.",
        message_id: "msg-1",
        index: 0,
        final: true,
      },
    ]);
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      "https://omnigent.test/v1/sessions/session%2Fvoice/stream",
    );
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("accept")).toBe(
      "text/event-stream",
    );
  });

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

  it("reads the installed session project folder contract", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "opaque", expires_in: 3600 }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([{ id: "project-base", name: "Base Project", icon: null }]),
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

    await expect(client.listSessionProjects()).resolves.toEqual([
      { id: "project-base", name: "Base Project", icon: null },
    ]);
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      "https://omnigent.test/v1/sessions/projects",
    );
  });
});
