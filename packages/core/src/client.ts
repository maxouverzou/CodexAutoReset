import { type Credentials, validateCredentials } from "./auth.js";
import { AppError, HttpError, TokenExpiredError, invalidResponse } from "./errors.js";
import { parseUsage, parseCredits, parseRedemption, type UsageSnapshot, type ResetCreditList, type RedemptionResult } from "./schema.js";

const BASE = "https://chatgpt.com/backend-api/wham";

function retryAfter(value: string | null, now: number): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const ms = Number(trimmed) * 1000;
    return Number.isFinite(ms) ? ms : null;
  }
  // Do not allow Date.parse's permissive handling of arbitrary numeric strings.
  if (!/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), /i.test(trimmed)) return null;
  const date = Date.parse(trimmed);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

export class CodexClient {
  private readonly credentials: Credentials;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(credentials: Credentials, options: { fetch?: typeof globalThis.fetch; now?: () => number; timeoutMs?: number } = {}) {
    this.credentials = validateCredentials(credentials);
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 2_147_483_647) {
      throw new AppError("invalid_options", "The request timeout is invalid.");
    }
  }

  getUsage(): Promise<UsageSnapshot> {
    return this.request("/usage", parseUsage);
  }
  listResetCredits(): Promise<ResetCreditList> {
    return this.request("/rate-limit-reset-credits", parseCredits);
  }
  redeemReset(creditId: string, requestId: string): Promise<RedemptionResult> {
    if (typeof creditId !== "string" || !creditId.trim() || typeof requestId !== "string" || !requestId.trim()) {
      return Promise.reject(new AppError("invalid_request", "A credit and stable request identifier are required."));
    }
    return this.request("/rate-limit-reset-credits/consume", parseRedemption, {
      credit_id: creditId, redeem_request_id: requestId,
    });
  }

  private async request<T>(path: string, parse: (value: unknown) => T, body?: object): Promise<T> {
    const now = this.now();
    if (!Number.isFinite(now)) throw new AppError("invalid_options", "The request clock is invalid.");
    if (this.credentials.expires <= now) throw new TokenExpiredError();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const transportError = () => new AppError("transport_error", "The request could not be completed. Its outcome may be uncertain.");
    const operation = async (): Promise<T> => {
      let response: Response;
      try {
        response = await this.fetcher(`${BASE}${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            Authorization: `Bearer ${this.credentials.access}`,
            "chatgpt-account-id": this.credentials.accountId,
            Accept: "application/json",
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: "error",
          signal: controller.signal,
        });
      } catch {
        throw transportError();
      }
      // Defense in depth for injected/nonconforming fetch implementations.
      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        throw new AppError("redirect_rejected", "The service redirected the request.");
      }
      if (!response.ok) throw new HttpError(response.status, retryAfter(response.headers.get("retry-after"), this.now()));
      let value: unknown;
      try {
        value = await response.json();
      } catch (error) {
        if (error instanceof SyntaxError) invalidResponse();
        throw transportError();
      }
      return parse(value);
    };
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(transportError());
            controller.abort();
          }, this.timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
