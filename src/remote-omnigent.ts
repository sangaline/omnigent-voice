import { JsonObject } from "./omnigent.js";

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export interface CliLoginStart {
  ticket: string;
  loginUrl: string;
}

export interface CliLoginGrant {
  accountId: string;
  oidcIssuer: string;
  oidcSubject: string;
  refreshToken: string;
}

export interface OmnigentGrantClientOptions {
  baseUrl: URL;
  fetch?: typeof fetch;
}

export class OmnigentGrantClient {
  private readonly fetcher: typeof fetch;

  public constructor(private readonly options: OmnigentGrantClientOptions) {
    this.fetcher = options.fetch ?? fetch;
  }

  public async startCliLogin(): Promise<CliLoginStart> {
    const url = new URL("/auth/cli-login", this.options.baseUrl);
    url.searchParams.set("grant_client_id", "omnigent-mcp");
    const response = await this.fetcher(url, {
      method: "POST",
      headers: { accept: "application/json" },
    });
    const payload = await this.json(response);
    if (!response.ok || typeof payload.ticket !== "string" || typeof payload.login_url !== "string") {
      throw new Error(`Omnigent CLI login initialization failed with HTTP ${response.status}`);
    }
    const loginUrl = new URL(payload.login_url, this.options.baseUrl);
    if (loginUrl.origin !== this.options.baseUrl.origin || loginUrl.pathname !== "/auth/login") {
      throw new Error("Omnigent returned an unsafe CLI login URL");
    }
    return { ticket: payload.ticket, loginUrl: `${loginUrl.pathname}${loginUrl.search}` };
  }

  public async pollCliLogin(ticket: string): Promise<CliLoginGrant | "pending"> {
    const url = new URL("/auth/cli-poll", this.options.baseUrl);
    url.searchParams.set("ticket", ticket);
    const response = await this.fetcher(url, { headers: { accept: "application/json" } });
    const payload = await this.json(response);
    if (response.status === 202) return "pending";
    if (!response.ok) {
      throw new Error(`Omnigent CLI login completion failed with HTTP ${response.status}`);
    }
    if (
      typeof payload.user_id !== "string" ||
      typeof payload.oidc_issuer !== "string" ||
      typeof payload.oidc_subject !== "string" ||
      typeof payload.refresh_token !== "string"
    ) {
      throw new Error("Omnigent CLI login did not return a delegated OIDC grant");
    }
    return {
      accountId: payload.user_id,
      oidcIssuer: payload.oidc_issuer,
      oidcSubject: payload.oidc_subject,
      refreshToken: payload.refresh_token,
    };
  }

  public async accessToken(
    refreshToken: string,
  ): Promise<{ token: string; refreshToken: string; expiresIn: number }> {
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken });
    const response = await this.fetcher(new URL("/oauth/token", this.options.baseUrl), {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    });
    const payload = await this.json(response);
    if (!response.ok || typeof payload.access_token !== "string") {
      throw new Error(`Omnigent grant refresh failed with HTTP ${response.status}`);
    }
    return {
      token: payload.access_token,
      refreshToken:
        typeof payload.refresh_token === "string" ? payload.refresh_token : refreshToken,
      expiresIn: typeof payload.expires_in === "number" ? payload.expires_in : 3_600,
    };
  }

  public async revoke(refreshToken: string): Promise<void> {
    const body = new URLSearchParams({ refresh_token: refreshToken });
    await this.fetcher(new URL("/oauth/revoke", this.options.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    }).catch(() => undefined);
  }

  public async listSessions(accessToken: string, limit: number): Promise<JsonObject[]> {
    const url = new URL("/v1/sessions", this.options.baseUrl);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("sort_by", "updated_at");
    url.searchParams.set("order", "desc");
    url.searchParams.set("kind", "default");
    const response = await this.fetcher(url, {
      headers: { accept: "application/json", authorization: `Bearer ${accessToken}` },
    });
    const payload = await this.json(response);
    if (!response.ok || !Array.isArray(payload.data)) {
      throw new Error(`Omnigent sessions request failed with HTTP ${response.status}`);
    }
    return payload.data.filter(isObject);
  }

  private async json(response: Response): Promise<JsonObject> {
    const payload: unknown = await response.json().catch(() => undefined);
    return isObject(payload) ? payload : {};
  }
}
