import { describe, expect, it, vi } from "vitest";
import {
  formatConversationItem,
  formatConversationItems,
  OmnigentCoordinator,
  timeAgo,
} from "./coordinator.js";
import { Logger } from "./log.js";
import { CoordinatorMcpClient } from "./mcp.js";
import { OmnigentClient } from "./omnigent.js";

describe("Omnigent coordinator", () => {
  it("formats stable voice-facing time and output", () => {
    expect(timeAgo("2026-08-28T12:00:00Z", Date.parse("2026-08-28T12:03:00Z"))).toBe(
      "3 minutes ago",
    );
    expect(
      formatConversationItem({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Deployment is ready." }],
      }),
    ).toBe("assistant: Deployment is ready.");
    expect(
      formatConversationItem({
        type: "terminal_command",
        input: "kubectl get pods",
        stdout: "voice 1/1 Running",
        stderr: "",
      }),
    ).toContain("voice 1/1 Running");

    const structured = formatConversationItems(
      [
        {
          type: "function_call",
          created_at: "2026-08-28T12:02:30Z",
          name: "exec_command",
          arguments: '{"cmd":"npm test"}',
        },
        {
          type: "message",
          created_at: "2026-08-28T12:02:00Z",
          role: "assistant",
          content: [{ type: "output_text", text: "All tests pass." }],
        },
      ],
      Date.parse("2026-08-28T12:03:00Z"),
    );
    expect(structured).toEqual({
      items: [
        {
          position: 1,
          occurred_at: "2026-08-28T12:02:30.000Z",
          time_ago: "30 seconds ago",
          kind: "tool_call",
          tool_name: "exec_command",
          text: 'tool call exec_command: {"cmd":"npm test"}',
          text_truncated: false,
        },
        {
          position: 2,
          occurred_at: "2026-08-28T12:02:00.000Z",
          time_ago: "1 minute ago",
          kind: "message",
          role: "assistant",
          text: "All tests pass.",
          text_truncated: false,
        },
      ],
      omitted: 0,
    });
  });

  it("exposes the focused coordinator tools over an in-memory MCP transport", async () => {
    const now = new Date().toISOString();
    const session = {
      id: "session-1",
      title: "Voice MVP",
      status: "running",
      updated_at: now,
      pending_elicitations_count: 1,
    };
    const omnigent = {
      listSessions: vi.fn().mockResolvedValue([session]),
      getSession: vi.fn().mockResolvedValue(session),
      listItems: vi.fn().mockResolvedValue({
        data: [
          {
            id: "tool-newest",
            type: "function_call",
            created_at: now,
            name: "exec_command",
            arguments: '{"cmd":"npm test"}',
          },
          {
            id: "message-latest",
            type: "message",
            created_at: now,
            role: "assistant",
            content: "The replay harness is ready.",
          },
        ],
        hasMore: false,
      }),
      sendMessage: vi.fn(),
      resolveElicitation: vi.fn(),
      createSession: vi.fn(),
      archiveSession: vi.fn(),
      renameSession: vi.fn(),
      interruptSession: vi.fn(),
    } as unknown as OmnigentClient;
    const coordinator = new OmnigentCoordinator({
      omnigent,
      logger: new Logger("error"),
      pollIntervalMs: 60_000,
    });
    await coordinator.start();
    const client = await CoordinatorMcpClient.create(coordinator);
    try {
      const tools = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual([
        "list_sessions",
        "focus_session",
        "get_output",
        "poll_output",
        "send_message",
        "archive_session",
        "rename_session",
        "answer_prompt",
        "start_session",
        "check_updates",
      ]);
      await expect(
        client.callTool("list_sessions", { status: "waiting_for_input" }),
      ).resolves.toMatchObject({
        sessions: [
          { id: "session-1", name: "Voice MVP", pending_prompts: 1, focused: true },
        ],
        focused_session: { id: "session-1", name: "Voice MVP" },
        known_sessions: [
          { id: "session-1", name: "Voice MVP", focused: true },
        ],
        updates: [],
      });
      await expect(
        client.callTool("focus_session", { session_id: "session-1" }),
      ).resolves.toMatchObject({
        focused_session: { id: "session-1", name: "Voice MVP" },
        focus_changed: false,
        already_focused: true,
        recent_actions: [],
      });
      await expect(client.callTool("get_output", {})).resolves.toMatchObject({
        order: "oldest_to_newest",
        latest_message: {
          position: 1,
          kind: "message",
          role: "assistant",
          text: "The replay harness is ready.",
        },
        items: [
          {
            position: 1,
            kind: "message",
            role: "assistant",
            text: "The replay harness is ready.",
          },
          { position: 2, kind: "tool_call", tool_name: "exec_command" },
        ],
        items_omitted: 0,
      });
    } finally {
      coordinator.stop();
      await client.close();
    }
  });

  it("snapshots new stable output and keeps immediate delivery distinct from queuing", async () => {
    const now = new Date().toISOString();
    const session = {
      id: "session-1",
      title: "Voice MVP",
      status: "running",
      updated_at: now,
    };
    const listItems = vi
      .fn()
      .mockResolvedValueOnce({
        data: [{ id: "old", type: "message", role: "assistant", content: "Old" }],
        hasMore: false,
      })
      .mockResolvedValue({
        data: [
          {
            id: "new",
            type: "message",
            role: "assistant",
            content: "The deployment is ready.",
          },
          { id: "old", type: "message", role: "assistant", content: "Old" },
        ],
        hasMore: false,
      });
    const sendMessage = vi.fn().mockResolvedValue({ queued: true });
    const omnigent = {
      listSessions: vi.fn().mockResolvedValue([session]),
      getSession: vi.fn().mockResolvedValue(session),
      listItems,
      sendMessage,
      resolveElicitation: vi.fn(),
      createSession: vi.fn(),
      archiveSession: vi.fn(),
      renameSession: vi.fn(),
      interruptSession: vi.fn(),
    } as unknown as OmnigentClient;
    const coordinator = new OmnigentCoordinator({
      omnigent,
      logger: new Logger("error"),
      pollIntervalMs: 60_000,
    });
    await coordinator.start();
    const client = await CoordinatorMcpClient.create(coordinator);
    try {
      await expect(client.callTool("check_updates", {})).resolves.toMatchObject({
        focused_session: { id: "session-1", name: "Voice MVP" },
        output_delta: { changed: true, output: "assistant: The deployment is ready." },
      });
      const firstPoll = await client.callTool("poll_output", {});
      expect(firstPoll).toMatchObject({
        changed: true,
        output: "assistant: The deployment is ready.",
        cursor: "new",
        cursor_expired: false,
      });
      await expect(
        client.callTool("poll_output", { cursor: firstPoll.cursor }),
      ).resolves.toMatchObject({
        changed: false,
        output: "",
        cursor: "new",
        cursor_expired: false,
      });
      const immediate = await client.callTool("send_message", { message: "Continue." });
      expect(immediate).toMatchObject({
        accepted: true,
        delivery: "immediate",
        target_session: { id: "session-1", name: "Voice MVP" },
        backend_async_accepted: true,
        recent_actions: [
          {
            action_id: 1,
            type: "message_sent",
            name: "Voice MVP",
            delivery: "immediate",
            message: "Continue.",
          },
        ],
      });
      expect(immediate).not.toHaveProperty("queued");
      listItems.mockResolvedValue({
        data: [
          { id: "sent-user", type: "message", role: "user", content: "Continue." },
          { id: "new", type: "message", role: "assistant", content: "Ready." },
        ],
        hasMore: false,
      });
      await expect(client.callTool("get_output", {})).resolves.toMatchObject({
        recent_delivery_visibility: {
          action_id: 1,
          delivery: "immediate",
          status: "visible_on_page",
          matching_position: 2,
          page: 1,
        },
      });
      await expect(
        client.callTool("send_message", { message: "Do this later.", delivery: "queued" }),
      ).resolves.toMatchObject({
        accepted: true,
        delivery: "queued",
        target_session: { id: "session-1", name: "Voice MVP" },
        queued_messages: 1,
      });
      expect(sendMessage).toHaveBeenCalledTimes(1);
    } finally {
      coordinator.stop();
      await client.close();
    }
  });

  it("restores the previous focus after archiving a temporary session", async () => {
    const now = new Date().toISOString();
    const primary = {
      id: "session-primary",
      title: "Primary work",
      status: "idle",
      updated_at: now,
    };
    const temporary = {
      id: "session-temporary",
      title: "Temporary side task",
      status: "idle",
      updated_at: now,
    };
    const listSessions = vi
      .fn()
      .mockResolvedValueOnce([primary, temporary])
      .mockResolvedValue([primary]);
    const archiveSession = vi.fn().mockResolvedValue({ archived: true });
    const omnigent = {
      listSessions,
      getSession: vi.fn().mockImplementation((id: string) =>
        Promise.resolve(id === temporary.id ? temporary : primary),
      ),
      listItems: vi.fn().mockResolvedValue({ data: [], hasMore: false }),
      sendMessage: vi.fn(),
      resolveElicitation: vi.fn(),
      createSession: vi.fn(),
      archiveSession,
      renameSession: vi.fn(),
      interruptSession: vi.fn(),
    } as unknown as OmnigentClient;
    const coordinator = new OmnigentCoordinator({
      omnigent,
      logger: new Logger("error"),
      pollIntervalMs: 60_000,
    });
    await coordinator.start();
    const client = await CoordinatorMcpClient.create(coordinator);
    try {
      await client.callTool("focus_session", { session_id: temporary.id });
      await expect(client.callTool("archive_session", {})).resolves.toMatchObject({
        archived: true,
        archived_session: { id: temporary.id, name: "Temporary side task" },
        focus_reason: "previous_focus",
        focused_session: { id: primary.id, name: "Primary work" },
        recent_actions: [
          { type: "focus_changed", name: "Temporary side task" },
          {
            type: "session_archived",
            name: "Temporary side task",
            next_focus: { id: primary.id, name: "Primary work" },
          },
        ],
      });
      expect(archiveSession).toHaveBeenCalledWith(temporary.id);
    } finally {
      coordinator.stop();
      await client.close();
    }
  });

  it("renames the focused session without changing focus", async () => {
    const now = new Date().toISOString();
    const session = {
      id: "session-voice",
      title: "Voice MVP",
      status: "idle",
      updated_at: now,
    };
    const renameSession = vi.fn().mockResolvedValue({
      ...session,
      title: "Audio Packet Research",
    });
    const omnigent = {
      listSessions: vi.fn().mockResolvedValue([session]),
      getSession: vi.fn().mockResolvedValue(session),
      listItems: vi.fn().mockResolvedValue({ data: [], hasMore: false }),
      sendMessage: vi.fn(),
      resolveElicitation: vi.fn(),
      createSession: vi.fn(),
      archiveSession: vi.fn(),
      renameSession,
      interruptSession: vi.fn(),
    } as unknown as OmnigentClient;
    const coordinator = new OmnigentCoordinator({
      omnigent,
      logger: new Logger("error"),
      pollIntervalMs: 60_000,
    });
    await coordinator.start();
    const client = await CoordinatorMcpClient.create(coordinator);
    try {
      await expect(
        client.callTool("rename_session", { title: "Audio Packet Research" }),
      ).resolves.toMatchObject({
        renamed: true,
        previous_name: "Voice MVP",
        new_name: "Audio Packet Research",
        renamed_session: {
          id: "session-voice",
          name: "Audio Packet Research",
        },
        focus_changed: false,
        focused_session: {
          id: "session-voice",
          name: "Audio Packet Research",
        },
        known_sessions: [
          {
            id: "session-voice",
            name: "Audio Packet Research",
            focused: true,
          },
        ],
        recent_actions: [
          {
            type: "session_renamed",
            previous_name: "Voice MVP",
            new_name: "Audio Packet Research",
          },
        ],
      });
      expect(renameSession).toHaveBeenCalledWith(
        "session-voice",
        "Audio Packet Research",
      );
    } finally {
      coordinator.stop();
      await client.close();
    }
  });

  it("publishes stable assistant output while a session is still running", async () => {
    const now = new Date().toISOString();
    const session = {
      id: "session-live",
      title: "Live Work",
      status: "running",
      updated_at: now,
    };
    const oldMessage = {
      id: "old-message",
      type: "message",
      role: "assistant",
      content: "Starting the checks.",
    };
    const newMessage = {
      id: "new-message",
      type: "message",
      role: "assistant",
      content: "The decoder now passes eight reconnect tests; the soak is still running.",
    };
    const toolOnly = {
      id: "tool-only",
      type: "function_call",
      name: "exec_command",
      arguments: '{"cmd":"run soak"}',
    };
    const listItems = vi
      .fn()
      .mockResolvedValueOnce({ data: [oldMessage], hasMore: false })
      .mockResolvedValueOnce({ data: [newMessage, oldMessage], hasMore: false })
      .mockResolvedValueOnce({ data: [toolOnly, newMessage, oldMessage], hasMore: false });
    const omnigent = {
      listSessions: vi.fn().mockResolvedValue([session]),
      getSession: vi.fn().mockResolvedValue(session),
      listItems,
      sendMessage: vi.fn(),
      resolveElicitation: vi.fn(),
      createSession: vi.fn(),
      archiveSession: vi.fn(),
      renameSession: vi.fn(),
      interruptSession: vi.fn(),
    } as unknown as OmnigentClient;
    const coordinator = new OmnigentCoordinator({
      omnigent,
      logger: new Logger("error"),
      pollIntervalMs: 60_000,
    });
    await coordinator.start();
    const pushed: Array<{ type?: unknown; session_id?: unknown }> = [];
    const unsubscribe = coordinator.subscribeUpdates((update) => pushed.push(update));
    const client = await CoordinatorMcpClient.create(coordinator);
    try {
      await expect(
        client.callTool("check_updates", { after_event_id: 0 }),
      ).resolves.toMatchObject({
        output_delta: {
          changed: true,
          output: expect.stringContaining("eight reconnect tests"),
        },
        updates: [
          {
            event_id: 1,
            type: "session_output",
            session_id: "session-live",
            name: "Live Work",
            output_delta: {
              changed: true,
              output: expect.stringContaining("eight reconnect tests"),
            },
          },
        ],
      });
      expect(pushed).toEqual([
        expect.objectContaining({ type: "session_output", session_id: "session-live" }),
      ]);
      await expect(
        client.callTool("check_updates", { after_event_id: 1 }),
      ).resolves.toMatchObject({
        output_delta: {
          changed: true,
          output: expect.stringContaining("run soak"),
        },
        updates: [],
        update_cursor: 1,
      });
      expect(pushed).toHaveLength(1);
    } finally {
      unsubscribe();
      coordinator.stop();
      await client.close();
    }
  });

  it("supports replayable event cursors without globally draining updates", async () => {
    const now = new Date().toISOString();
    const running = {
      id: "session-1",
      title: "Voice MVP",
      status: "running",
      updated_at: now,
    };
    const idle = { ...running, status: "idle" };
    const omnigent = {
      listSessions: vi
        .fn()
        .mockResolvedValueOnce([running])
        .mockResolvedValue([idle]),
      getSession: vi.fn().mockResolvedValue(idle),
      listItems: vi.fn().mockResolvedValue({ data: [], hasMore: false }),
      sendMessage: vi.fn(),
      resolveElicitation: vi.fn(),
      createSession: vi.fn(),
      archiveSession: vi.fn(),
      renameSession: vi.fn(),
      interruptSession: vi.fn(),
    } as unknown as OmnigentClient;
    const coordinator = new OmnigentCoordinator({
      omnigent,
      logger: new Logger("error"),
      pollIntervalMs: 60_000,
    });
    await coordinator.start();
    const client = await CoordinatorMcpClient.create(coordinator);
    try {
      const first = await client.callTool("check_updates", { after_event_id: 0 });
      expect(first).toMatchObject({
        update_cursor: 1,
        update_cursor_expired: false,
        updates: [{ event_id: 1, type: "session_completed", session_id: "session-1" }],
      });
      await expect(client.callTool("list_sessions", {})).resolves.toMatchObject({
        update_cursor: 1,
        updates: [],
      });
      await expect(
        client.callTool("check_updates", { after_event_id: 0 }),
      ).resolves.toMatchObject({
        update_cursor: 1,
        updates: [{ event_id: 1, type: "session_completed" }],
      });
      await expect(
        client.callTool("check_updates", { after_event_id: 1 }),
      ).resolves.toMatchObject({ update_cursor: 1, updates: [] });
    } finally {
      coordinator.stop();
      await client.close();
    }
  });

  it("retains exact pending decision identifiers until the prompt is resolved", async () => {
    const now = new Date().toISOString();
    const primary = {
      id: "session-primary",
      title: "Primary Work",
      status: "running",
      updated_at: now,
    };
    const betaIdle = {
      id: "session-beta",
      title: "Side Beta",
      status: "waiting",
      updated_at: now,
      pending_elicitations_count: 0,
    };
    const betaPending = {
      ...betaIdle,
      pending_elicitations_count: 1,
    };
    const betaSnapshot = {
      ...betaPending,
      pending_elicitations: [
        {
          elicitation_id: "prompt-restart",
          params: {
            message: "Allow the test worker to restart?",
            mode: "confirmation",
          },
        },
      ],
    };
    const resolveElicitation = vi.fn();
    const omnigent = {
      listSessions: vi
        .fn()
        .mockResolvedValueOnce([primary, betaIdle])
        .mockResolvedValue([primary, betaPending]),
      getSession: vi.fn().mockImplementation((id: string) =>
        Promise.resolve(id === betaPending.id ? betaSnapshot : primary),
      ),
      listItems: vi.fn().mockResolvedValue({ data: [], hasMore: false }),
      sendMessage: vi.fn(),
      resolveElicitation,
      createSession: vi.fn(),
      archiveSession: vi.fn(),
      renameSession: vi.fn(),
      interruptSession: vi.fn(),
    } as unknown as OmnigentClient;
    const coordinator = new OmnigentCoordinator({
      omnigent,
      logger: new Logger("error"),
      pollIntervalMs: 60_000,
    });
    await coordinator.start();
    const client = await CoordinatorMcpClient.create(coordinator);
    try {
      await expect(
        client.callTool("check_updates", { after_event_id: 0 }),
      ).resolves.toMatchObject({
        pending_decisions: [
          {
            session_id: "session-beta",
            name: "Side Beta",
            prompts: [
              {
                prompt_id: "prompt-restart",
                message: "Allow the test worker to restart?",
                mode: "confirmation",
              },
            ],
          },
        ],
        updates: [
          {
            event_id: 1,
            type: "decision_needed",
            session_id: "session-beta",
            prompts: [{ prompt_id: "prompt-restart" }],
          },
        ],
      });
      await expect(
        client.callTool("answer_prompt", {
          session_id: "session-beta",
          prompt_id: "prompt-restart",
          action: "accept",
        }),
      ).resolves.toMatchObject({
        resolved: true,
        session_id: "session-beta",
        prompt_id: "prompt-restart",
        action: "accept",
        pending_decisions: [],
        recent_actions: [
          { type: "prompt_answered", name: "Side Beta", action: "accept" },
        ],
      });
      expect(resolveElicitation).toHaveBeenCalledWith(
        "session-beta",
        "prompt-restart",
        "accept",
        undefined,
      );
    } finally {
      coordinator.stop();
      await client.close();
    }
  });
});
