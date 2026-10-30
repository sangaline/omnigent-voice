import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { OmnigentGrantClient } from "./remote-omnigent.js";

interface CapturedRequest {
  url: URL;
  init: RequestInit | undefined;
}

const setup = (status = 202) => {
  const requests: CapturedRequest[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    requests.push({ url, init });
    if (url.pathname === "/auth/cli-login") {
      return Response.json({ ticket: "test-ticket", login_url: "/auth/login?ticket=test-ticket" });
    }
    return Response.json({ error: "test-response" }, { status });
  };
  return {
    requests,
    client: new OmnigentGrantClient({ baseUrl: new URL("https://unit.example"), fetch: fetcher }),
  };
};

describe("upstream delegated login PKCE", () => {
  it("creates an independent random S256 proof for each upstream login", async () => {
    const { client, requests } = setup();
    const first = await client.startCliLogin();
    const second = await client.startCliLogin();
    expect(first.upstreamCodeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second.upstreamCodeVerifier).not.toBe(first.upstreamCodeVerifier);
    const request = requests[0]!;
    expect(request.url.searchParams.get("grant_client_id")).toBe("omnigent-mcp");
    expect(request.init?.redirect).toBe("error");
    expect(new Headers(request.init?.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(request.init?.body))).toEqual({
      code_challenge: createHash("sha256").update(first.upstreamCodeVerifier).digest("base64url"),
      code_challenge_method: "S256",
    });
    expect(first.loginUrl).not.toContain(first.upstreamCodeVerifier);
    expect(request.url.href).not.toContain(first.upstreamCodeVerifier);
  });

  it("sends proof only through the polling header and keeps pending status", async () => {
    const { client, requests } = setup();
    const login = await client.startCliLogin();
    expect(await client.pollCliLogin(login.ticket, login.upstreamCodeVerifier)).toBe("pending");
    const request = requests[1]!;
    expect(request.url.searchParams.get("ticket")).toBe(login.ticket);
    expect(request.url.href).not.toContain(login.upstreamCodeVerifier);
    expect(new Headers(request.init?.headers).get("X-Omnigent-Code-Verifier"))
      .toBe(login.upstreamCodeVerifier);
    expect(request.init?.redirect).toBe("error");
  });

  it("refuses missing and malformed proof before sending a request", async () => {
    const { client, requests } = setup();
    for (const verifier of ["", "short", "v".repeat(129), " ".repeat(43)]) {
      await expect(client.pollCliLogin("test-ticket", verifier)).rejects.toThrow("valid PKCE verifier");
    }
    expect(requests).toHaveLength(0);
  });

  it("fails closed on rejected proof without returning credential content", async () => {
    const { client } = setup(403);
    await expect(client.pollCliLogin("test-ticket", "v".repeat(43)))
      .rejects.toThrow("Omnigent CLI login completion failed with HTTP 403");
  });
});
