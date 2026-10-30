export interface RemoteMcpConfig {
  enabled: boolean;
  port: number;
  publicOrigin: URL;
  resourceUrl: URL;
  omnigentBaseUrl: URL;
  databasePath: string;
  encryptionKey: Buffer;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  authorizationTtlSeconds: number;
}

const required = (name: string, value = process.env[name]): string => {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
};

const positiveInteger = (name: string, fallback: number): number => {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
};

const httpsOrigin = (value: string): URL => {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("REMOTE_MCP_PUBLIC_ORIGIN must be a bare HTTPS origin");
  }
  if (url.pathname !== "/") {
    throw new Error("REMOTE_MCP_PUBLIC_ORIGIN must not contain a path");
  }
  return url;
};

const internalUrl = (value: string): URL => {
  const url = new URL(value);
  if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password) {
    throw new Error("REMOTE_MCP_OMNIGENT_URL must be an HTTP(S) URL without credentials");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  url.search = "";
  url.hash = "";
  return url;
};

const encryptionKey = (value: string): Buffer => {
  const key = Buffer.from(value, "base64");
  if (key.length !== 32 || key.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")) {
    throw new Error("REMOTE_MCP_ENCRYPTION_KEY must be exactly 32 base64-encoded bytes");
  }
  return key;
};

export const loadRemoteMcpConfig = (): RemoteMcpConfig => {
  const publicOrigin = httpsOrigin(required("REMOTE_MCP_PUBLIC_ORIGIN"));
  return {
    enabled: process.env.REMOTE_MCP_ENABLED === "true",
    port: positiveInteger("REMOTE_MCP_PORT", 3000),
    publicOrigin,
    resourceUrl: new URL("/mcp", publicOrigin),
    omnigentBaseUrl: internalUrl(required("REMOTE_MCP_OMNIGENT_URL")),
    databasePath: required("REMOTE_MCP_DATABASE_PATH"),
    encryptionKey: encryptionKey(required("REMOTE_MCP_ENCRYPTION_KEY")),
    accessTokenTtlSeconds: positiveInteger("REMOTE_MCP_ACCESS_TOKEN_TTL_SECONDS", 600),
    refreshTokenTtlSeconds: positiveInteger("REMOTE_MCP_REFRESH_TOKEN_TTL_SECONDS", 2_592_000),
    authorizationTtlSeconds: positiveInteger("REMOTE_MCP_AUTHORIZATION_TTL_SECONDS", 300),
  };
};
