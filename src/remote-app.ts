import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { RemoteMcpConfig } from "./remote-config.js";
import { SecretBox, secretHash } from "./remote-crypto.js";
import { OmnigentGrantClient } from "./remote-omnigent.js";
import { RemoteOAuthProvider } from "./remote-provider.js";
import { RemoteStore, remoteReadScope } from "./remote-store.js";
import { RemoteToolService } from "./remote-tools.js";

const escapeHtml = (value: string): string =>
  value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[character] ?? character);

const transactionSecret = (request: Request): string | undefined => {
  const value = request.method === "POST" ? request.body?.transaction : request.query.transaction;
  if (typeof value !== "string" || value.length < 32 || value.length > 128) return undefined;
  return value;
};

const redirectWith = (
  redirectUri: string,
  values: Record<string, string | undefined>,
): string => {
  const url = new URL(redirectUri);
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined) url.searchParams.set(name, value);
  }
  return url.href;
};

const consentHtml = (options: {
  transaction: string;
  clientName: string;
  accountId: string;
  scopes: string[];
}): string => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize Omnigent</title></head>
<body>
  <main>
    <h1>Authorize Omnigent access</h1>
    <p><strong>${escapeHtml(options.clientName)}</strong> is requesting read-only access to Omnigent account <strong>${escapeHtml(options.accountId)}</strong>.</p>
    <p>Allowed now: list your accessible sessions and identify the connected account.</p>
    <p>Not allowed: sending messages, starting work, changing sessions, approving prompts, or administrative access.</p>
    <p>Requested scope: <code>${escapeHtml(options.scopes.join(" "))}</code></p>
    <form method="post" action="/mcp/oauth/consent">
      <input type="hidden" name="transaction" value="${escapeHtml(options.transaction)}">
      <button type="submit" name="decision" value="approve">Approve read-only access</button>
      <button type="submit" name="decision" value="deny">Deny</button>
    </form>
  </main>
</body>
</html>`;

const errorHtml = (message: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorization failed</title></head>
<body><main><h1>Authorization failed</h1><p>${escapeHtml(message)}</p></main></body></html>`;

const safeError = (error: unknown): string =>
  error instanceof Error ? error.constructor.name : "UnknownError";

export interface RemoteMcpApplication {
  app: Express;
  store: RemoteStore;
  provider: RemoteOAuthProvider;
}

export const createRemoteMcpApplication = (
  config: RemoteMcpConfig,
  dependencies: { fetch?: typeof fetch } = {},
): RemoteMcpApplication => {
  if (!config.enabled) throw new Error("Remote MCP is disabled");
  const store = new RemoteStore({
    path: config.databasePath,
    secretBox: new SecretBox(config.encryptionKey),
    resourceUrl: config.resourceUrl,
    accessTokenTtlSeconds: config.accessTokenTtlSeconds,
    refreshTokenTtlSeconds: config.refreshTokenTtlSeconds,
    authorizationTtlSeconds: config.authorizationTtlSeconds,
  });
  const omnigent = new OmnigentGrantClient({
    baseUrl: config.omnigentBaseUrl,
    ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
  });
  const provider = new RemoteOAuthProvider({
    store,
    omnigent,
    publicOrigin: config.publicOrigin,
    resourceUrl: config.resourceUrl,
  });
  const tools = new RemoteToolService(store, omnigent);
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  app.use((_request: Request, response: Response, next: NextFunction) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    next();
  });
  app.use(express.json({ limit: "64kb", type: ["application/json", "application/*+json"] }));

  app.get("/healthz", (_request, response) => response.status(200).json({ status: "ok" }));

  app.get("/mcp/oauth/callback", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const transaction = transactionSecret(request);
    if (!transaction) {
      response.status(400).type("html").send(errorHtml("The authorization transaction is invalid."));
      return;
    }
    try {
      await provider.completeOmnigentLogin(transaction);
      const authorization = provider.authorization(transaction);
      const client = store.getClient(authorization.clientId);
      if (!client || !authorization.accountId) throw new Error("Authorization client is unavailable");
      response.status(200).type("html").send(consentHtml({
        transaction,
        clientName: client.client_name ?? "An MCP client",
        accountId: authorization.accountId,
        scopes: authorization.scopes,
      }));
    } catch (error) {
      process.stdout.write(`${JSON.stringify({
        time: new Date().toISOString(),
        event: "remote_mcp.authorization_callback_failed",
        error: safeError(error),
      })}\n`);
      response.status(400).type("html").send(errorHtml("The Omnigent login could not be completed. Start the connection again."));
    }
  });

  app.post(
    "/mcp/oauth/consent",
    express.urlencoded({ extended: false, limit: "8kb" }),
    async (request, response) => {
      response.setHeader("Cache-Control", "no-store");
      if (request.get("origin") !== config.publicOrigin.origin) {
        response.status(403).type("html").send(errorHtml("The consent request origin is invalid."));
        return;
      }
      const transaction = transactionSecret(request);
      const decision = request.body?.decision;
      if (!transaction || (decision !== "approve" && decision !== "deny")) {
        response.status(400).type("html").send(errorHtml("The consent request is invalid."));
        return;
      }
      try {
        if (decision === "deny") {
          const denied = await provider.deny(transaction);
          response.redirect(302, redirectWith(denied.redirectUri, {
            error: "access_denied",
            error_description: "The user denied the authorization request",
            state: denied.state,
          }));
          return;
        }
        const approved = provider.approve(transaction);
        response.redirect(302, redirectWith(approved.redirectUri, {
          code: approved.authorizationCode,
          state: approved.state,
        }));
      } catch (error) {
        process.stdout.write(`${JSON.stringify({
          time: new Date().toISOString(),
          event: "remote_mcp.consent_failed",
          error: safeError(error),
        })}\n`);
        response.status(400).type("html").send(errorHtml("The authorization could not be completed. Start the connection again."));
      }
    },
  );

  app.use(mcpAuthRouter({
    provider,
    issuerUrl: config.publicOrigin,
    baseUrl: config.publicOrigin,
    resourceServerUrl: config.resourceUrl,
    scopesSupported: [remoteReadScope],
    resourceName: "Omnigent",
    authorizationOptions: { rateLimit: { windowMs: 15 * 60_000, limit: 40 } },
    tokenOptions: { rateLimit: { windowMs: 15 * 60_000, limit: 40 } },
    clientRegistrationOptions: { rateLimit: { windowMs: 60 * 60_000, limit: 10 } },
    revocationOptions: { rateLimit: { windowMs: 15 * 60_000, limit: 40 } },
  }));

  const bearer = requireBearerAuth({
    verifier: provider,
    requiredScopes: [remoteReadScope],
    resourceMetadataUrl: new URL(
      "/.well-known/oauth-protected-resource/mcp",
      config.publicOrigin,
    ).href,
  });

  app.post("/mcp", bearer, async (request, response) => {
    if (!request.auth) {
      response.status(401).end();
      return;
    }
    const server = tools.createServer(request.auth);
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    try {
      await server.connect(transport as unknown as Transport);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({
        time: new Date().toISOString(),
        event: "remote_mcp.request_failed",
        error: safeError(error),
      })}\n`);
      if (!response.headersSent) {
        response.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    } finally {
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });
  app.get("/mcp", bearer, (_request, response) => {
    response.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Server notifications are not enabled" },
      id: null,
    });
  });
  app.delete("/mcp", bearer, (_request, response) => response.status(405).end());

  return { app, store, provider };
};
