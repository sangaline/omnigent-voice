import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRemoteMcpApplication, type RemoteMcpApplication } from "./remote-app.js";
import type { RemoteMcpConfig } from "./remote-config.js";

interface FakeAccount {
  accountId: string;
  issuer: string;
  subject: string;
  refreshToken: string;
  sessions: Array<Record<string, unknown>>;
}

class FakeOmnigent {
  public readonly accounts: FakeAccount[] = [];
  public readonly revoked: string[] = [];
  private readonly ticketAccounts = new Map<string, FakeAccount>();
  private ticketCounter = 0;

  public enqueue(account: FakeAccount): void {
    this.accounts.push(account);
  }

  public fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.pathname === "/auth/cli-login" && init?.method === "POST") {
      const account = this.accounts.shift();
      if (!account) return Response.json({ error: "no test account" }, { status: 500 });
      const ticket = `private-ticket-${++this.ticketCounter}`;
      this.ticketAccounts.set(ticket, account);
      return Response.json({ ticket, login_url: `/auth/login?ticket=${ticket}` });
    }
    if (url.pathname === "/auth/cli-poll") {
      const account = this.ticketAccounts.get(url.searchParams.get("ticket") ?? "");
      if (!account) return Response.json({ error: "gone" }, { status: 410 });
      return Response.json({
        token: "unused-session-token",
        user_id: account.accountId,
        oidc_issuer: account.issuer,
        oidc_subject: account.subject,
        refresh_token: account.refreshToken,
      });
    }
    if (url.pathname === "/oauth/token") {
      const body = new URLSearchParams(String(init?.body ?? ""));
      const refreshToken = body.get("refresh_token") ?? "";
      const account = this.allAccounts().find((entry) => entry.refreshToken === refreshToken);
      if (!account || this.revoked.includes(refreshToken)) {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      return Response.json({
        access_token: `access-for:${account.subject}`,
        refresh_token: refreshToken,
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    if (url.pathname === "/oauth/revoke") {
      const body = new URLSearchParams(String(init?.body ?? ""));
      const refreshToken = body.get("refresh_token");
      if (refreshToken) this.revoked.push(refreshToken);
      return Response.json({ revoked: true });
    }
    if (url.pathname === "/v1/sessions") {
      const authorization = new Headers(init?.headers).get("authorization") ?? "";
      const subject = authorization.replace("Bearer access-for:", "");
      const account = this.allAccounts().find((entry) => entry.subject === subject);
      if (!account) return Response.json({ error: "unauthorized" }, { status: 401 });
      return Response.json({ data: account.sessions });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  };

  private allAccounts(): FakeAccount[] {
    return [...this.accounts, ...this.ticketAccounts.values()];
  }
}

interface RunningApp {
  application: RemoteMcpApplication;
  server: Server;
  url: string;
  directory: string;
  databasePath: string;
  fake: FakeOmnigent;
}

interface AuthorizedConnection {
  clientId: string;
  accessToken: string;
  refreshToken: string;
  authorizationCode: string;
  codeVerifier: string;
  transaction: string;
  upstreamTicket: string;
}

const running: RunningApp[] = [];

afterEach(async () => {
  for (const item of running.splice(0)) {
    await new Promise<void>((resolve) => item.server.close(() => resolve()));
    item.application.store.close();
    await rm(item.directory, { recursive: true, force: true });
  }
});

const start = async (): Promise<RunningApp> => {
  const directory = await mkdtemp(join(tmpdir(), "omnigent-mcp-test-"));
  const databasePath = join(directory, "state.sqlite");
  const fake = new FakeOmnigent();
  const config: RemoteMcpConfig = {
    enabled: true,
    port: 0,
    publicOrigin: new URL("https://unit.example"),
    resourceUrl: new URL("https://unit.example/mcp"),
    omnigentBaseUrl: new URL("http://omnigent.internal"),
    databasePath,
    encryptionKey: randomBytes(32),
    accessTokenTtlSeconds: 600,
    refreshTokenTtlSeconds: 3600,
    authorizationTtlSeconds: 300,
  };
  const application = createRemoteMcpApplication(config, { fetch: fake.fetch });
  const server = createServer(application.app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  const value = {
    application,
    server,
    url: `http://127.0.0.1:${address.port}`,
    directory,
    databasePath,
    fake,
  };
  running.push(value);
  return value;
};

const register = async (app: RunningApp, redirectUri = "https://client.example/callback") => {
  const response = await fetch(`${app.url}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      client_name: "Test Claude Connector",
    }),
  });
  return { response, body: await response.json() as Record<string, unknown> };
};

const authorize = async (
  app: RunningApp,
  account: FakeAccount,
): Promise<AuthorizedConnection> => {
  app.fake.enqueue(account);
  const registration = await register(app);
  expect(registration.response.status).toBe(201);
  const clientId = String(registration.body.client_id);
  const codeVerifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(codeVerifier).digest("base64url");
  const authorization = new URL(`${app.url}/authorize`);
  authorization.searchParams.set("response_type", "code");
  authorization.searchParams.set("client_id", clientId);
  authorization.searchParams.set("redirect_uri", "https://client.example/callback");
  authorization.searchParams.set("code_challenge", challenge);
  authorization.searchParams.set("code_challenge_method", "S256");
  authorization.searchParams.set("scope", "omnigent.read");
  authorization.searchParams.set("resource", "https://unit.example/mcp");
  authorization.searchParams.set("state", "client-state");
  const authResponse = await fetch(authorization, { redirect: "manual" });
  expect(authResponse.status).toBe(302);
  const loginLocation = new URL(authResponse.headers.get("location") ?? "");
  expect(loginLocation.origin).toBe("https://unit.example");
  expect(loginLocation.pathname).toBe("/auth/login");
  const upstreamTicket = loginLocation.searchParams.get("ticket") ?? "";
  const returnTo = new URL(loginLocation.searchParams.get("return_to") ?? "", "https://unit.example");
  const transaction = returnTo.searchParams.get("transaction") ?? "";
  expect(transaction).toMatch(/^omv_tx_/);

  const callback = await fetch(`${app.url}/mcp/oauth/callback?transaction=${encodeURIComponent(transaction)}`);
  expect(callback.status).toBe(200);
  expect(await callback.text()).toContain("read-only access");

  const consent = await fetch(`${app.url}/mcp/oauth/consent`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: "https://unit.example",
    },
    body: new URLSearchParams({ transaction, decision: "approve" }),
  });
  expect(consent.status).toBe(302);
  const clientRedirect = new URL(consent.headers.get("location") ?? "");
  expect(clientRedirect.searchParams.get("state")).toBe("client-state");
  const authorizationCode = clientRedirect.searchParams.get("code") ?? "";

  const token = await fetch(`${app.url}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code: authorizationCode,
      code_verifier: codeVerifier,
      redirect_uri: "https://client.example/callback",
      resource: "https://unit.example/mcp",
    }),
  });
  expect(token.status).toBe(200);
  const tokens = await token.json() as Record<string, unknown>;
  return {
    clientId,
    accessToken: String(tokens.access_token),
    refreshToken: String(tokens.refresh_token),
    authorizationCode,
    codeVerifier,
    transaction,
    upstreamTicket,
  };
};

const callTool = async (
  app: RunningApp,
  accessToken: string,
  name: string,
  args: Record<string, unknown> = {},
) => {
  const response = await fetch(`${app.url}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  return { response, body: await response.json() as Record<string, unknown> };
};

const account = (suffix: string): FakeAccount => ({
  accountId: `account-${suffix}@example.invalid`,
  issuer: "https://issuer.example.invalid",
  subject: `stable-subject-${suffix}`,
  refreshToken: `private-upstream-refresh-${suffix}`,
  sessions: [{ id: `session-${suffix}`, title: `Session ${suffix}`, status: "idle" }],
});

describe("remote MCP OAuth gateway", () => {
  it("publishes exact OAuth discovery and challenges unauthenticated MCP calls", async () => {
    const app = await start();
    const resource = await fetch(`${app.url}/.well-known/oauth-protected-resource/mcp`);
    expect(resource.status).toBe(200);
    expect(await resource.json()).toMatchObject({
      resource: "https://unit.example/mcp",
      authorization_servers: ["https://unit.example/"],
      scopes_supported: ["omnigent.read"],
    });
    const metadata = await fetch(`${app.url}/.well-known/oauth-authorization-server`);
    expect(await metadata.json()).toMatchObject({
      issuer: "https://unit.example/",
      authorization_endpoint: "https://unit.example/authorize",
      token_endpoint: "https://unit.example/token",
      registration_endpoint: "https://unit.example/register",
      revocation_endpoint: "https://unit.example/revoke",
    });
    const unauthenticated = await fetch(`${app.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("www-authenticate")).toContain(
      "resource_metadata=\"https://unit.example/.well-known/oauth-protected-resource/mcp\"",
    );
  });

  it("rejects unsafe and confidential dynamic clients", async () => {
    const app = await start();
    const insecure = await register(app, "http://client.example/callback");
    expect(insecure.response.status).toBe(400);
    const confidential = await fetch(`${app.url}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["https://client.example/callback"],
        token_endpoint_auth_method: "client_secret_post",
      }),
    });
    expect(confidential.status).toBe(400);
  });

  it("requires same-origin explicit consent", async () => {
    const app = await start();
    app.fake.enqueue(account("csrf"));
    const registration = await register(app);
    const codeVerifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(codeVerifier).digest("base64url");
    const url = new URL(`${app.url}/authorize`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", String(registration.body.client_id));
    url.searchParams.set("redirect_uri", "https://client.example/callback");
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    const startResponse = await fetch(url, { redirect: "manual" });
    const login = new URL(startResponse.headers.get("location") ?? "");
    const returnTo = new URL(login.searchParams.get("return_to") ?? "", "https://unit.example");
    const transaction = returnTo.searchParams.get("transaction") ?? "";
    await fetch(`${app.url}/mcp/oauth/callback?transaction=${encodeURIComponent(transaction)}`);
    const consent = await fetch(`${app.url}/mcp/oauth/consent`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ transaction, decision: "approve" }),
    });
    expect(consent.status).toBe(403);
  });

  it("keeps two accounts isolated through delegated upstream ACLs", async () => {
    const app = await start();
    const alpha = await authorize(app, account("alpha"));
    const beta = await authorize(app, account("beta"));
    const alphaResult = await callTool(app, alpha.accessToken, "list_sessions");
    const betaResult = await callTool(app, beta.accessToken, "list_sessions");
    expect(alphaResult.response.status).toBe(200);
    expect(JSON.stringify(alphaResult.body)).toContain("session-alpha");
    expect(JSON.stringify(alphaResult.body)).not.toContain("session-beta");
    expect(JSON.stringify(betaResult.body)).toContain("session-beta");
    expect(JSON.stringify(betaResult.body)).not.toContain("session-alpha");
  });

  it("rejects bad PKCE, code replay, and a mismatched token resource", async () => {
    const app = await start();
    app.fake.enqueue(account("grants"));
    const registration = await register(app);
    const clientId = String(registration.body.client_id);
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const url = new URL(`${app.url}/authorize`);
    for (const [key, value] of Object.entries({
      response_type: "code",
      client_id: clientId,
      redirect_uri: "https://client.example/callback",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: "https://unit.example/mcp",
    })) url.searchParams.set(key, value);
    const startResponse = await fetch(url, { redirect: "manual" });
    const login = new URL(startResponse.headers.get("location") ?? "");
    const returnTo = new URL(login.searchParams.get("return_to") ?? "", "https://unit.example");
    const transaction = returnTo.searchParams.get("transaction") ?? "";
    await fetch(`${app.url}/mcp/oauth/callback?transaction=${encodeURIComponent(transaction)}`);
    const consent = await fetch(`${app.url}/mcp/oauth/consent`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://unit.example" },
      body: new URLSearchParams({ transaction, decision: "approve" }),
    });
    const code = new URL(consent.headers.get("location") ?? "").searchParams.get("code") ?? "";
    const exchange = async (codeVerifier: string, resource = "https://unit.example/mcp") => fetch(`${app.url}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        code_verifier: codeVerifier,
        redirect_uri: "https://client.example/callback",
        resource,
      }),
    });
    expect((await exchange("wrong-verifier")).status).toBe(400);
    expect((await exchange(verifier, "https://wrong.example/mcp")).status).toBe(400);
    expect((await exchange(verifier)).status).toBe(200);
    expect((await exchange(verifier)).status).toBe(400);
  });

  it("rotates refresh tokens, revokes the grant on reuse, and revokes upstream", async () => {
    const app = await start();
    const connection = await authorize(app, account("reuse"));
    const refresh = async (token: string) => fetch(`${app.url}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: connection.clientId,
        refresh_token: token,
        resource: "https://unit.example/mcp",
      }),
    });
    const rotatedResponse = await refresh(connection.refreshToken);
    expect(rotatedResponse.status).toBe(200);
    const rotated = await rotatedResponse.json() as Record<string, unknown>;
    const replay = await refresh(connection.refreshToken);
    expect(replay.status).toBe(400);
    expect(app.fake.revoked).toContain("private-upstream-refresh-reuse");
    expect((await callTool(app, String(rotated.access_token), "whoami")).response.status).toBe(401);
  });

  it("never stores raw tickets, codes, or gateway/upstream tokens", async () => {
    const app = await start();
    const connection = await authorize(app, account("storage"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const files = [app.databasePath, `${app.databasePath}-wal`]
      .map((path) => {
        try { return readFileSync(path).toString("latin1"); } catch { return ""; }
      })
      .join("");
    for (const secret of [
      connection.transaction,
      connection.upstreamTicket,
      connection.authorizationCode,
      connection.accessToken,
      connection.refreshToken,
      "private-upstream-refresh-storage",
    ]) {
      expect(files).not.toContain(secret);
    }
  });
});
