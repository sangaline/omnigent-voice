import type { Response } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import {
  InvalidGrantError,
  InvalidTargetError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { opaqueSecret, secretHash } from "./remote-crypto.js";
import { OmnigentGrantClient } from "./remote-omnigent.js";
import { RemoteStore } from "./remote-store.js";

export interface RemoteOAuthProviderOptions {
  store: RemoteStore;
  omnigent: OmnigentGrantClient;
  publicOrigin: URL;
  resourceUrl: URL;
}

export class RemoteOAuthProvider implements OAuthServerProvider {
  public readonly clientsStore;
  private readonly store: RemoteStore;
  private readonly omnigent: OmnigentGrantClient;
  private readonly publicOrigin: URL;
  private readonly resourceUrl: URL;

  public constructor(options: RemoteOAuthProviderOptions) {
    this.store = options.store;
    this.clientsStore = options.store;
    this.omnigent = options.omnigent;
    this.publicOrigin = options.publicOrigin;
    this.resourceUrl = options.resourceUrl;
  }

  public async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    if (params.resource && params.resource.href !== this.resourceUrl.href) {
      throw new InvalidTargetError("The requested resource does not match this MCP server");
    }
    const login = await this.omnigent.startCliLogin();
    const transactionSecret = opaqueSecret("omv_tx");
    this.store.createAuthorization(transactionSecret, client, params, login.ticket);

    const loginUrl = new URL(login.loginUrl, this.publicOrigin);
    const callback = new URL("/mcp/oauth/callback", this.publicOrigin);
    callback.searchParams.set("transaction", transactionSecret);
    loginUrl.searchParams.set("return_to", `${callback.pathname}${callback.search}`);
    res.redirect(302, loginUrl.href);
  }

  public challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    return Promise.resolve(
      this.store.challengeForAuthorizationCode(client.client_id, authorizationCode),
    );
  }

  public exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    return Promise.resolve(
      this.store.exchangeAuthorizationCode(
        client.client_id,
        authorizationCode,
        redirectUri,
        resource,
      ),
    );
  }

  public async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const result = this.store.exchangeRefreshToken(
      client.client_id,
      refreshToken,
      scopes,
      resource,
    );
    if (result.reusedGrant) {
      if (result.reusedUpstreamRefreshToken) {
        await this.omnigent.revoke(result.reusedUpstreamRefreshToken);
      }
      throw new InvalidGrantError("Refresh token reuse detected; the grant was revoked");
    }
    return result.tokens;
  }

  public verifyAccessToken(token: string): Promise<AuthInfo> {
    return Promise.resolve(this.store.verifyAccessToken(token));
  }

  public async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    const revoked = this.store.revokeByToken(request.token, client.client_id);
    if (revoked.upstreamRefreshToken) {
      await this.omnigent.revoke(revoked.upstreamRefreshToken);
    }
  }

  public async completeOmnigentLogin(transactionSecret: string): Promise<void> {
    const transactionHash = secretHash(transactionSecret);
    const transaction = this.store.getAuthorization(transactionHash);
    if (transaction.status === "authenticated") return;
    if (transaction.status !== "pending") {
      throw new InvalidGrantError("Authorization transaction was already completed");
    }
    const grant = await this.omnigent.pollCliLogin(transaction.ticket);
    if (grant === "pending") {
      throw new InvalidGrantError("Omnigent login has not completed");
    }
    this.store.attachIdentity(transactionHash, grant);
  }

  public authorization(transactionSecret: string) {
    return this.store.getAuthorization(secretHash(transactionSecret));
  }

  public approve(transactionSecret: string) {
    return this.store.approveAuthorization(secretHash(transactionSecret));
  }

  public async deny(transactionSecret: string) {
    const denied = this.store.denyAuthorization(secretHash(transactionSecret));
    if (denied.upstreamRefreshToken) await this.omnigent.revoke(denied.upstreamRefreshToken);
    return denied;
  }
}
