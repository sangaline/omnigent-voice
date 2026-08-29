import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { opaqueSecret, SecretBox, secretHash } from "./remote-crypto.js";
import type { CliLoginGrant } from "./remote-omnigent.js";

type Row = Record<string, unknown>;

const READ_SCOPE = "omnigent.read";
const ALLOWED_SCOPES = new Set([READ_SCOPE]);

const asString = (value: unknown, name: string): string => {
  if (typeof value !== "string" || !value) throw new Error(`Database field ${name} is invalid`);
  return value;
};

const asNumber = (value: unknown, name: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Database field ${name} is invalid`);
  }
  return value;
};

const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value ? value : undefined;

const parseScopes = (value: unknown): string[] => {
  const parsed: unknown = JSON.parse(asString(value, "scopes_json"));
  if (!Array.isArray(parsed) || !parsed.every((scope) => typeof scope === "string")) {
    throw new Error("Database scopes are invalid");
  }
  return parsed;
};

const validateRedirect = (raw: string): void => {
  const url = new URL(raw);
  const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]).has(url.hostname);
  if (url.hash || url.username || url.password) {
    throw new InvalidClientMetadataError("redirect_uris cannot contain fragments or credentials");
  }
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
    throw new InvalidClientMetadataError("redirect_uris must use HTTPS or an HTTP loopback address");
  }
};

const validateScopes = (requested: readonly string[] | undefined): string[] => {
  const scopes = requested?.length ? [...new Set(requested)] : [READ_SCOPE];
  if (scopes.some((scope) => !ALLOWED_SCOPES.has(scope))) {
    throw new InvalidScopeError("Only omnigent.read is available in the initial release");
  }
  if (!scopes.includes(READ_SCOPE)) scopes.push(READ_SCOPE);
  return scopes;
};

export interface RemoteStoreOptions {
  path: string;
  secretBox: SecretBox;
  resourceUrl: URL;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  authorizationTtlSeconds: number;
}

export interface PendingAuthorization {
  transactionHash: string;
  clientId: string;
  redirectUri: string;
  state?: string;
  scopes: string[];
  codeChallenge: string;
  resource: string;
  ticket: string;
  expiresAt: number;
  status: string;
  accountId?: string;
  oidcIssuer?: string;
  oidcSubject?: string;
}

export interface AuthorizationRedirect {
  redirectUri: string;
  state?: string;
  authorizationCode?: string;
  upstreamRefreshToken?: string;
}

export interface GrantIdentity {
  grantId: string;
  accountId: string;
  oidcIssuer: string;
  oidcSubject: string;
  clientId: string;
  scopes: string[];
}

export class RemoteStore implements OAuthRegisteredClientsStore {
  private readonly db: DatabaseSync;

  public constructor(private readonly options: RemoteStoreOptions) {
    mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(options.path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.migrate();
  }

  public close(): void {
    this.db.close();
  }

  public getClient(clientId: string): OAuthClientInformationFull | undefined {
    const row = this.db.prepare("SELECT metadata_json FROM oauth_clients WHERE client_id = ?").get(clientId) as Row | undefined;
    if (!row) return undefined;
    const parsed: unknown = JSON.parse(asString(row.metadata_json, "metadata_json"));
    return parsed as OAuthClientInformationFull;
  }

  public registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at"> &
      Partial<Pick<OAuthClientInformationFull, "client_id" | "client_id_issued_at">>,
  ): OAuthClientInformationFull {
    if (!client.client_id || !client.client_id_issued_at) {
      throw new InvalidClientMetadataError("Server-generated client identity is required");
    }
    if (client.redirect_uris.length < 1 || client.redirect_uris.length > 5) {
      throw new InvalidClientMetadataError("Between one and five redirect_uris are required");
    }
    client.redirect_uris.forEach(validateRedirect);
    if (client.token_endpoint_auth_method && client.token_endpoint_auth_method !== "none") {
      throw new InvalidClientMetadataError("Only public PKCE clients are supported");
    }
    if (client.client_name && client.client_name.length > 120) {
      throw new InvalidClientMetadataError("client_name is too long");
    }
    const normalized: OAuthClientInformationFull = {
      ...client,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: READ_SCOPE,
      client_id: client.client_id,
      client_id_issued_at: client.client_id_issued_at,
    };
    delete normalized.client_secret;
    delete normalized.client_secret_expires_at;
    this.db.prepare(
      "INSERT INTO oauth_clients (client_id, metadata_json, created_at) VALUES (?, ?, ?)",
    ).run(normalized.client_id, JSON.stringify(normalized), Math.floor(Date.now() / 1000));
    return normalized;
  }

  public createAuthorization(
    transactionSecret: string,
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    ticket: string,
  ): PendingAuthorization {
    const transactionHash = secretHash(transactionSecret);
    const now = Math.floor(Date.now() / 1000);
    const resource = params.resource?.href ?? this.options.resourceUrl.href;
    if (resource !== this.options.resourceUrl.href) {
      throw new InvalidTargetError("The requested resource does not match this MCP server");
    }
    const scopes = validateScopes(params.scopes);
    this.db.prepare(`
      INSERT INTO auth_transactions (
        transaction_hash, client_id, redirect_uri, state, scopes_json,
        code_challenge, resource, ticket_ciphertext, status, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(
      transactionHash,
      client.client_id,
      params.redirectUri,
      params.state ?? null,
      JSON.stringify(scopes),
      params.codeChallenge,
      resource,
      this.options.secretBox.seal(ticket, `transaction:${transactionHash}:ticket`),
      now,
      now + this.options.authorizationTtlSeconds,
    );
    return this.getAuthorization(transactionHash);
  }

  public getAuthorization(transactionHash: string): PendingAuthorization {
    const row = this.db.prepare("SELECT * FROM auth_transactions WHERE transaction_hash = ?").get(transactionHash) as Row | undefined;
    if (!row) throw new InvalidGrantError("Authorization transaction is invalid");
    const expiresAt = asNumber(row.expires_at, "expires_at");
    if (expiresAt <= Math.floor(Date.now() / 1000)) {
      throw new InvalidGrantError("Authorization transaction expired");
    }
    const state = optionalString(row.state);
    const accountId = optionalString(row.account_id);
    const oidcIssuer = optionalString(row.oidc_issuer);
    const oidcSubject = optionalString(row.oidc_subject);
    return {
      transactionHash,
      clientId: asString(row.client_id, "client_id"),
      redirectUri: asString(row.redirect_uri, "redirect_uri"),
      ...(state ? { state } : {}),
      scopes: parseScopes(row.scopes_json),
      codeChallenge: asString(row.code_challenge, "code_challenge"),
      resource: asString(row.resource, "resource"),
      ticket: this.options.secretBox.open(
        asString(row.ticket_ciphertext, "ticket_ciphertext"),
        `transaction:${transactionHash}:ticket`,
      ),
      expiresAt,
      status: asString(row.status, "status"),
      ...(accountId ? { accountId } : {}),
      ...(oidcIssuer ? { oidcIssuer } : {}),
      ...(oidcSubject ? { oidcSubject } : {}),
    };
  }

  public attachIdentity(transactionHash: string, grant: CliLoginGrant): PendingAuthorization {
    this.transaction(() => {
      const current = this.getAuthorization(transactionHash);
      if (current.status !== "pending") {
        throw new InvalidGrantError("Authorization transaction was already completed");
      }
      const bySubject = this.db.prepare(
        "SELECT account_id FROM identity_links WHERE oidc_issuer = ? AND oidc_subject = ?",
      ).get(grant.oidcIssuer, grant.oidcSubject) as Row | undefined;
      if (bySubject && bySubject.account_id !== grant.accountId) {
        throw new InvalidGrantError("OIDC identity is linked to a different Omnigent account");
      }
      const byAccount = this.db.prepare(
        "SELECT oidc_issuer, oidc_subject FROM identity_links WHERE account_id = ?",
      ).get(grant.accountId) as Row | undefined;
      if (
        byAccount &&
        (byAccount.oidc_issuer !== grant.oidcIssuer || byAccount.oidc_subject !== grant.oidcSubject)
      ) {
        throw new InvalidGrantError("Omnigent account is linked to a different OIDC identity");
      }
      this.db.prepare(`
        INSERT OR IGNORE INTO identity_links
          (oidc_issuer, oidc_subject, account_id, created_at, last_verified_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(grant.oidcIssuer, grant.oidcSubject, grant.accountId, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000));
      this.db.prepare(`
        UPDATE identity_links SET last_verified_at = ?
        WHERE oidc_issuer = ? AND oidc_subject = ? AND account_id = ?
      `).run(Math.floor(Date.now() / 1000), grant.oidcIssuer, grant.oidcSubject, grant.accountId);
      this.db.prepare(`
        UPDATE auth_transactions
        SET account_id = ?, oidc_issuer = ?, oidc_subject = ?,
            upstream_grant_ciphertext = ?, status = 'authenticated'
        WHERE transaction_hash = ? AND status = 'pending'
      `).run(
        grant.accountId,
        grant.oidcIssuer,
        grant.oidcSubject,
        this.options.secretBox.seal(
          grant.refreshToken,
          `transaction:${transactionHash}:upstream`,
        ),
        transactionHash,
      );
    });
    return this.getAuthorization(transactionHash);
  }

  public approveAuthorization(transactionHash: string): AuthorizationRedirect {
    return this.transaction(() => {
      const transaction = this.getAuthorization(transactionHash);
      if (transaction.status !== "authenticated") {
        throw new InvalidGrantError("Authorization transaction is not ready for consent");
      }
      if (!transaction.accountId || !transaction.oidcIssuer || !transaction.oidcSubject) {
        throw new InvalidGrantError("Authorization identity is incomplete");
      }
      const row = this.db.prepare(
        "SELECT upstream_grant_ciphertext FROM auth_transactions WHERE transaction_hash = ?",
      ).get(transactionHash) as Row;
      const upstreamRefresh = this.options.secretBox.open(
        asString(row.upstream_grant_ciphertext, "upstream_grant_ciphertext"),
        `transaction:${transactionHash}:upstream`,
      );
      const authorizationCode = opaqueSecret("omv_code");
      const codeHash = secretHash(authorizationCode);
      const now = Math.floor(Date.now() / 1000);
      this.db.prepare(`
        INSERT INTO authorization_codes (
          code_hash, client_id, redirect_uri, scopes_json, code_challenge,
          resource, account_id, oidc_issuer, oidc_subject,
          upstream_grant_ciphertext, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        codeHash,
        transaction.clientId,
        transaction.redirectUri,
        JSON.stringify(transaction.scopes),
        transaction.codeChallenge,
        transaction.resource,
        transaction.accountId,
        transaction.oidcIssuer,
        transaction.oidcSubject,
        this.options.secretBox.seal(upstreamRefresh, `code:${codeHash}:upstream`),
        now,
        now + 120,
      );
      this.db.prepare(
        "UPDATE auth_transactions SET status = 'approved', upstream_grant_ciphertext = NULL WHERE transaction_hash = ?",
      ).run(transactionHash);
      return {
        redirectUri: transaction.redirectUri,
        ...(transaction.state ? { state: transaction.state } : {}),
        authorizationCode,
      };
    });
  }

  public denyAuthorization(transactionHash: string): AuthorizationRedirect {
    return this.transaction(() => {
      const transaction = this.getAuthorization(transactionHash);
      if (transaction.status !== "authenticated") {
        throw new InvalidGrantError("Authorization transaction is not ready for consent");
      }
      const row = this.db.prepare(
        "SELECT upstream_grant_ciphertext FROM auth_transactions WHERE transaction_hash = ?",
      ).get(transactionHash) as Row;
      const upstreamRefreshToken = this.options.secretBox.open(
        asString(row.upstream_grant_ciphertext, "upstream_grant_ciphertext"),
        `transaction:${transactionHash}:upstream`,
      );
      this.db.prepare(
        "UPDATE auth_transactions SET status = 'denied', upstream_grant_ciphertext = NULL WHERE transaction_hash = ?",
      ).run(transactionHash);
      return {
        redirectUri: transaction.redirectUri,
        ...(transaction.state ? { state: transaction.state } : {}),
        upstreamRefreshToken,
      };
    });
  }

  public challengeForAuthorizationCode(clientId: string, authorizationCode: string): string {
    const row = this.db.prepare(
      "SELECT client_id, code_challenge, expires_at, used_at FROM authorization_codes WHERE code_hash = ?",
    ).get(secretHash(authorizationCode)) as Row | undefined;
    if (
      !row ||
      row.client_id !== clientId ||
      row.used_at !== null ||
      asNumber(row.expires_at, "expires_at") <= Math.floor(Date.now() / 1000)
    ) {
      throw new InvalidGrantError("Authorization code is invalid or expired");
    }
    return asString(row.code_challenge, "code_challenge");
  }

  public exchangeAuthorizationCode(
    clientId: string,
    authorizationCode: string,
    redirectUri: string | undefined,
    resource: URL | undefined,
  ): OAuthTokens {
    return this.transaction(() => {
      const codeHash = secretHash(authorizationCode);
      const row = this.db.prepare("SELECT * FROM authorization_codes WHERE code_hash = ?").get(codeHash) as Row | undefined;
      const now = Math.floor(Date.now() / 1000);
      if (!row || row.client_id !== clientId || row.used_at !== null || asNumber(row.expires_at, "expires_at") <= now) {
        throw new InvalidGrantError("Authorization code is invalid or expired");
      }
      if (redirectUri === undefined || row.redirect_uri !== redirectUri) {
        throw new InvalidGrantError("redirect_uri does not match the authorization request");
      }
      const expectedResource = asString(row.resource, "resource");
      if ((resource?.href ?? expectedResource) !== expectedResource || expectedResource !== this.options.resourceUrl.href) {
        throw new InvalidTargetError("resource does not match the authorization request");
      }
      const changed = this.db.prepare(
        "UPDATE authorization_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL",
      ).run(now, codeHash);
      if (changed.changes !== 1) throw new InvalidGrantError("Authorization code was already used");

      const grantId = opaqueSecret("omv_grant");
      const upstreamRefresh = this.options.secretBox.open(
        asString(row.upstream_grant_ciphertext, "upstream_grant_ciphertext"),
        `code:${codeHash}:upstream`,
      );
      this.db.prepare(`
        INSERT INTO grants (
          grant_id, client_id, account_id, oidc_issuer, oidc_subject, scopes_json,
          resource, upstream_grant_ciphertext, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        grantId,
        clientId,
        asString(row.account_id, "account_id"),
        asString(row.oidc_issuer, "oidc_issuer"),
        asString(row.oidc_subject, "oidc_subject"),
        asString(row.scopes_json, "scopes_json"),
        expectedResource,
        this.options.secretBox.seal(upstreamRefresh, `grant:${grantId}:upstream`),
        now,
      );
      return this.issueTokenPair(grantId, clientId, parseScopes(row.scopes_json), now);
    });
  }

  public exchangeRefreshToken(
    clientId: string,
    refreshToken: string,
    requestedScopes: string[] | undefined,
    resource: URL | undefined,
  ): {
    tokens: OAuthTokens;
    reusedGrant?: GrantIdentity;
    reusedUpstreamRefreshToken?: string;
  } {
    return this.transaction(() => {
      const tokenHash = secretHash(refreshToken);
      const row = this.db.prepare(`
        SELECT rt.status, rt.expires_at, rt.grant_id, g.*
        FROM refresh_tokens rt JOIN grants g ON g.grant_id = rt.grant_id
        WHERE rt.token_hash = ?
      `).get(tokenHash) as Row | undefined;
      const now = Math.floor(Date.now() / 1000);
      if (!row || row.client_id !== clientId || asNumber(row.expires_at, "expires_at") <= now) {
        throw new InvalidGrantError("Refresh token is invalid or expired");
      }
      const identity = this.identityFromRow(row);
      if (row.status !== "current" || row.revoked_at !== null) {
        const reusedUpstreamRefreshToken = row.revoked_at === null
          ? this.options.secretBox.open(
              asString(row.upstream_grant_ciphertext, "upstream_grant_ciphertext"),
              `grant:${identity.grantId}:upstream`,
            )
          : undefined;
        this.revokeGrant(identity.grantId, now);
        return {
          tokens: { access_token: "", token_type: "Bearer" },
          reusedGrant: identity,
          ...(reusedUpstreamRefreshToken ? { reusedUpstreamRefreshToken } : {}),
        };
      }
      const grantedScopes = parseScopes(row.scopes_json);
      const scopes = requestedScopes?.length ? [...new Set(requestedScopes)] : grantedScopes;
      if (scopes.some((scope) => !grantedScopes.includes(scope))) {
        throw new InvalidScopeError("Requested scope exceeds the original grant");
      }
      const expectedResource = asString(row.resource, "resource");
      if ((resource?.href ?? expectedResource) !== expectedResource || expectedResource !== this.options.resourceUrl.href) {
        throw new InvalidTargetError("resource does not match this grant");
      }
      this.db.prepare("UPDATE refresh_tokens SET status = 'used', used_at = ? WHERE token_hash = ? AND status = 'current'").run(now, tokenHash);
      return { tokens: this.issueTokenPair(identity.grantId, clientId, scopes, now) };
    });
  }

  public verifyAccessToken(token: string): AuthInfo {
    const row = this.db.prepare(`
      SELECT at.expires_at AS access_expires_at, at.revoked_at AS access_revoked_at, g.*
      FROM access_tokens at JOIN grants g ON g.grant_id = at.grant_id
      WHERE at.token_hash = ?
    `).get(secretHash(token)) as Row | undefined;
    const now = Math.floor(Date.now() / 1000);
    if (
      !row ||
      row.access_revoked_at !== null ||
      row.revoked_at !== null ||
      asNumber(row.access_expires_at, "access_expires_at") <= now ||
      row.resource !== this.options.resourceUrl.href
    ) {
      throw new InvalidTokenError("Access token is invalid, expired, or revoked");
    }
    const identity = this.identityFromRow(row);
    return {
      token,
      clientId: identity.clientId,
      scopes: identity.scopes,
      expiresAt: asNumber(row.access_expires_at, "access_expires_at"),
      resource: this.options.resourceUrl,
      extra: {
        grant_id: identity.grantId,
        account_id: identity.accountId,
        oidc_issuer: identity.oidcIssuer,
        oidc_subject: identity.oidcSubject,
      },
    };
  }

  public grantIdentity(grantId: string): GrantIdentity {
    const row = this.db.prepare("SELECT * FROM grants WHERE grant_id = ? AND revoked_at IS NULL").get(grantId) as Row | undefined;
    if (!row) throw new InvalidTokenError("Grant is revoked or unavailable");
    return this.identityFromRow(row);
  }

  public upstreamRefreshToken(grantId: string): string {
    const row = this.db.prepare(
      "SELECT upstream_grant_ciphertext, revoked_at FROM grants WHERE grant_id = ?",
    ).get(grantId) as Row | undefined;
    if (!row || row.revoked_at !== null) throw new InvalidTokenError("Grant is revoked or unavailable");
    return this.options.secretBox.open(
      asString(row.upstream_grant_ciphertext, "upstream_grant_ciphertext"),
      `grant:${grantId}:upstream`,
    );
  }

  public updateUpstreamRefreshToken(grantId: string, refreshToken: string): void {
    const changed = this.db.prepare(`
      UPDATE grants SET upstream_grant_ciphertext = ?
      WHERE grant_id = ? AND revoked_at IS NULL
    `).run(this.options.secretBox.seal(refreshToken, `grant:${grantId}:upstream`), grantId);
    if (changed.changes !== 1) throw new InvalidTokenError("Grant is revoked or unavailable");
  }

  public revokeByToken(
    token: string,
    clientId: string,
  ): { identity?: GrantIdentity; upstreamRefreshToken?: string } {
    return this.transaction(() => {
      const tokenHash = secretHash(token);
      const row = this.db.prepare(`
        SELECT g.* FROM grants g
        WHERE g.grant_id = (
          SELECT grant_id FROM access_tokens WHERE token_hash = ?
          UNION SELECT grant_id FROM refresh_tokens WHERE token_hash = ?
          LIMIT 1
        )
      `).get(tokenHash, tokenHash) as Row | undefined;
      if (!row || row.revoked_at !== null || row.client_id !== clientId) return {};
      const identity = this.identityFromRow(row);
      const upstreamRefreshToken = this.options.secretBox.open(
        asString(row.upstream_grant_ciphertext, "upstream_grant_ciphertext"),
        `grant:${identity.grantId}:upstream`,
      );
      this.revokeGrant(identity.grantId, Math.floor(Date.now() / 1000));
      return { identity, upstreamRefreshToken };
    });
  }

  public revokeGrantAndReadUpstream(grantId: string): string | undefined {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM grants WHERE grant_id = ?").get(grantId) as Row | undefined;
      if (!row || row.revoked_at !== null) return undefined;
      const upstream = this.options.secretBox.open(
        asString(row.upstream_grant_ciphertext, "upstream_grant_ciphertext"),
        `grant:${grantId}:upstream`,
      );
      this.revokeGrant(grantId, Math.floor(Date.now() / 1000));
      return upstream;
    });
  }

  public recordAudit(event: {
    correlationId: string;
    grantId: string;
    accountId: string;
    clientId: string;
    operation: string;
    outcome: "allowed" | "denied" | "failed";
  }): void {
    this.db.prepare(`
      INSERT INTO audit_events (
        correlation_id, grant_id, account_id, client_id, operation, outcome, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.correlationId,
      event.grantId,
      event.accountId,
      event.clientId,
      event.operation,
      event.outcome,
      Math.floor(Date.now() / 1000),
    );
  }

  private issueTokenPair(grantId: string, clientId: string, scopes: string[], now: number): OAuthTokens {
    const accessToken = opaqueSecret("omv_at");
    const refreshToken = opaqueSecret("omv_rt");
    this.db.prepare(`
      INSERT INTO access_tokens (token_hash, grant_id, client_id, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(secretHash(accessToken), grantId, clientId, now, now + this.options.accessTokenTtlSeconds);
    this.db.prepare(`
      INSERT INTO refresh_tokens (token_hash, grant_id, client_id, status, created_at, expires_at)
      VALUES (?, ?, ?, 'current', ?, ?)
    `).run(secretHash(refreshToken), grantId, clientId, now, now + this.options.refreshTokenTtlSeconds);
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: "Bearer",
      expires_in: this.options.accessTokenTtlSeconds,
      scope: scopes.join(" "),
    };
  }

  private revokeGrant(grantId: string, now: number): void {
    this.db.prepare("UPDATE grants SET revoked_at = COALESCE(revoked_at, ?) WHERE grant_id = ?").run(now, grantId);
    this.db.prepare("UPDATE access_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE grant_id = ?").run(now, grantId);
    this.db.prepare("UPDATE refresh_tokens SET status = 'revoked' WHERE grant_id = ?").run(grantId);
  }

  private identityFromRow(row: Row): GrantIdentity {
    return {
      grantId: asString(row.grant_id, "grant_id"),
      accountId: asString(row.account_id, "account_id"),
      oidcIssuer: asString(row.oidc_issuer, "oidc_issuer"),
      oidcSubject: asString(row.oidc_subject, "oidc_subject"),
      clientId: asString(row.client_id, "client_id"),
      scopes: parseScopes(row.scopes_json),
    };
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS oauth_clients (
        client_id TEXT PRIMARY KEY,
        metadata_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS identity_links (
        oidc_issuer TEXT NOT NULL,
        oidc_subject TEXT NOT NULL,
        account_id TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        last_verified_at INTEGER NOT NULL,
        PRIMARY KEY (oidc_issuer, oidc_subject)
      );
      CREATE TABLE IF NOT EXISTS auth_transactions (
        transaction_hash TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES oauth_clients(client_id),
        redirect_uri TEXT NOT NULL,
        state TEXT,
        scopes_json TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        resource TEXT NOT NULL,
        ticket_ciphertext TEXT NOT NULL,
        upstream_grant_ciphertext TEXT,
        account_id TEXT,
        oidc_issuer TEXT,
        oidc_subject TEXT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS authorization_codes (
        code_hash TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES oauth_clients(client_id),
        redirect_uri TEXT NOT NULL,
        scopes_json TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        resource TEXT NOT NULL,
        account_id TEXT NOT NULL,
        oidc_issuer TEXT NOT NULL,
        oidc_subject TEXT NOT NULL,
        upstream_grant_ciphertext TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS grants (
        grant_id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES oauth_clients(client_id),
        account_id TEXT NOT NULL,
        oidc_issuer TEXT NOT NULL,
        oidc_subject TEXT NOT NULL,
        scopes_json TEXT NOT NULL,
        resource TEXT NOT NULL,
        upstream_grant_ciphertext TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS access_tokens (
        token_hash TEXT PRIMARY KEY,
        grant_id TEXT NOT NULL REFERENCES grants(grant_id),
        client_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        token_hash TEXT PRIMARY KEY,
        grant_id TEXT NOT NULL REFERENCES grants(grant_id),
        client_id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        correlation_id TEXT NOT NULL,
        grant_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        outcome TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS access_tokens_grant_idx ON access_tokens(grant_id);
      CREATE INDEX IF NOT EXISTS refresh_tokens_grant_idx ON refresh_tokens(grant_id);
      CREATE INDEX IF NOT EXISTS auth_transactions_expiry_idx ON auth_transactions(expires_at);
      CREATE INDEX IF NOT EXISTS authorization_codes_expiry_idx ON authorization_codes(expires_at);
    `);
  }
}

export const remoteReadScope = READ_SCOPE;
