import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  AppError,
  CodexClient,
  HttpError,
  readCredentials,
  type Credentials,
  type RedemptionResult,
  type ResetCreditList,
  type UsageSnapshot,
} from "@codex-auto-reset/core";

export const DEFAULT_POLL_INTERVAL_MS = 5 * 60_000;
export const DEFAULT_REDEMPTION_LEAD_TIME_MS = 15 * 60_000;
const MAX_TIMER_MS = 2_147_483_647;

export interface DaemonEvent {
  level: "info" | "warn" | "error";
  code: string;
  message: string;
  at: number;
  creditId?: string;
  outcome?: string;
}

export interface DaemonOptions {
  authFile?: string;
  pollIntervalMs?: number;
  redemptionLeadTimeMs?: number;
  signal?: AbortSignal;
  onEvent?: (event: DaemonEvent) => void;
}

interface Client {
  listResetCredits(): Promise<ResetCreditList>;
  getUsage(): Promise<UsageSnapshot>;
  redeemReset(creditId: string, requestId: string): Promise<RedemptionResult>;
}

/** Injection points are for fixtures and clocks; defaults never modify Pi's store. */
export interface DaemonDependencies {
  readCredentials?: (authFile?: string) => Promise<Credentials>;
  createClient?: (credentials: Credentials) => Client;
  now?: () => number;
  randomUUID?: () => string;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

interface Attempt {
  requestId: string;
  expiresAt: number;
  uncertain: boolean;
}

export function validateTiming(pollIntervalMs: number, redemptionLeadTimeMs: number): void {
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > MAX_TIMER_MS ||
      !Number.isFinite(redemptionLeadTimeMs) || redemptionLeadTimeMs <= 0 ||
      redemptionLeadTimeMs > Number.MAX_SAFE_INTEGER || pollIntervalMs > redemptionLeadTimeMs / 2) {
    throw new Error("Poll interval must be positive, at most 2147483647ms, and no greater than half the positive redemption lead time.");
  }
}

/** Memory-only coordinator. Separate instances/processes deliberately do not share a lock. */
export class ResetDaemon {
  private readonly interval: number;
  private readonly leadTime: number;
  private readonly now: () => number;
  private readonly read: (authFile?: string) => Promise<Credentials>;
  private readonly makeClient: (credentials: Credentials) => Client;
  private readonly uuid: () => string;
  private readonly wait: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly attempts = new Map<string, Attempt>();
  private readonly suppressed = new Set<string>();
  private accountId: string | undefined;
  private inFlight: Promise<number> | undefined;
  private retryNotBefore = 0;
  private pollStartedAt = 0;

  constructor(private readonly options: DaemonOptions = {}, dependencies: DaemonDependencies = {}) {
    this.interval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.leadTime = options.redemptionLeadTimeMs ?? DEFAULT_REDEMPTION_LEAD_TIME_MS;
    validateTiming(this.interval, this.leadTime);
    this.now = dependencies.now ?? Date.now;
    this.read = dependencies.readCredentials ?? readCredentials;
    this.makeClient = dependencies.createClient ?? ((credentials) => new CodexClient(credentials));
    this.uuid = dependencies.randomUUID ?? randomUUID;
    this.wait = dependencies.sleep ?? (async (ms, signal) => {
      await sleep(ms, undefined, { signal });
    });
  }

  private emit(level: DaemonEvent["level"], code: string, message: string,
    details: Pick<DaemonEvent, "creditId" | "outcome"> = {}): void {
    this.options.onEvent?.({ level, code, message, at: this.now(), ...details });
  }

  private key(accountId: string, creditId: string): string {
    return JSON.stringify([accountId, creditId]);
  }

  private recordFailure(error: unknown): void {
    if (error instanceof HttpError && error.retryAfterMs !== null) {
      this.retryNotBefore = Math.max(this.retryNotBefore, this.now() + error.retryAfterMs);
    }
    // Never interpolate arbitrary exceptions: a transport or injected dependency may contain secrets.
    this.emit("warn", error instanceof AppError ? error.code : "poll_failed",
      error instanceof AppError ? error.message : "Poll failed; will try again on a subsequent interval.");
  }

  /** Concurrent callers share a poll rather than sending concurrent mutations. Returns next delay. */
  poll(): Promise<number> {
    if (this.inFlight) return this.inFlight;
    const task = this.tick().finally(() => { this.inFlight = undefined; });
    this.inFlight = task;
    return task;
  }

  private async tick(): Promise<number> {
    this.pollStartedAt = this.now();
    if (this.options.signal?.aborted) return this.interval;
    if (this.now() < this.retryNotBefore) return this.nextDelay();
    try {
      const credentials = await this.read(this.options.authFile);
      if (this.accountId !== undefined && this.accountId !== credentials.accountId) {
        this.emit("info", "account_changed", "Credential account changed; monitoring the newly selected account.");
      }
      this.accountId = credentials.accountId;
      if (credentials.expires <= this.now()) {
        this.emit("warn", "token_expired", "Pi's access token is expired; waiting for Pi to refresh it. Credentials will be read again next poll.");
        return this.nextDelay();
      }
      const client = this.makeClient(credentials);
      const listing = await client.listResetCredits();
      const now = this.now();
      // Retire uncertain attempts when their credit expires, even if it has disappeared from the listing.
      for (const [key, attempt] of this.attempts) {
        if (attempt.expiresAt <= now) {
          if (attempt.uncertain) this.emit("warn", "redemption_unresolved", "An attempted credit expired with an unresolved redemption outcome.");
          this.attempts.delete(key);
          this.suppressed.add(key);
        }
      }
      this.emit("info", "credits_checked", `Checked reset credits; ${listing.availableCount} reported available.`);
      const candidates = listing.credits.filter((credit) =>
        credit.resetType === "codex_rate_limits" && credit.status === "available" &&
        credit.id.length > 0 && credit.expiresAt !== null && Number.isFinite(credit.expiresAt) &&
        credit.expiresAt > now && credit.expiresAt - now <= this.leadTime &&
        !this.suppressed.has(this.key(credentials.accountId, credit.id)))
        .sort((a, b) => a.expiresAt! - b.expiresAt! || a.id.localeCompare(b.id));
      const credit = candidates[0];
      if (!credit || this.options.signal?.aborted) return this.nextDelay();

      // Bind the mutation to fresh credentials as well as fresh server details. If Pi changed
      // accounts during the GET, do not consume either account's credit until the next poll.
      const current = await this.read(this.options.authFile);
      if (current.accountId !== credentials.accountId) {
        this.emit("info", "account_changed_during_poll", "Account changed while fetching credits; redemption deferred.");
        return this.nextDelay();
      }
      if (current.expires <= this.now() || credit.expiresAt! <= this.now() || this.options.signal?.aborted) {
        this.emit("warn", "redemption_deferred", "Credentials or credit expired before redemption; no request sent.");
        return this.nextDelay();
      }
      const key = this.key(current.accountId, credit.id);
      const attempt = this.attempts.get(key) ?? {
        requestId: this.uuid(), expiresAt: credit.expiresAt!, uncertain: false,
      };
      this.attempts.set(key, attempt);
      let result: RedemptionResult;
      try {
        // From this point on, a local failure cannot generally prove the server did not act.
        attempt.uncertain = true;
        result = await this.makeClient(current).redeemReset(credit.id, attempt.requestId);
      } catch (error) {
        if (error instanceof AppError &&
            (error.code === "unknown_redemption_outcome" || error.code === "invalid_response")) {
          this.suppressed.add(key);
          this.emit("warn", "redemption_unknown", "Unrecognized redemption response; automatic attempts for this credit are suppressed until restart.", { creditId: credit.id });
        }
        this.recordFailure(error);
        return this.nextDelay();
      }
      attempt.uncertain = false;
      this.emit("info", "redemption_result", `Redemption outcome: ${result.outcome}.`,
        { creditId: credit.id, outcome: result.outcome });
      if (result.outcome !== "no_credit") {
        this.suppressed.add(key);
        this.attempts.delete(key);
      }
      if (result.outcome === "nothing_to_reset") return this.nextDelay();
      // Refresh independently of mutation success: a GET failure must not make a completed POST retryable.
      try {
        await this.makeClient(current).listResetCredits();
        if (result.outcome === "reset" || result.outcome === "already_redeemed") {
          await this.makeClient(current).getUsage();
        }
      } catch (error) {
        this.emit("warn", "post_redemption_refresh_failed", "Could not refresh server details after the redemption response; the response remains recorded.");
        this.recordFailure(error);
      }
    } catch (error) {
      this.recordFailure(error);
    }
    return this.nextDelay();
  }

  private nextDelay(): number {
    return Math.max(0, this.pollStartedAt + this.interval - this.now(), this.retryNotBefore - this.now());
  }

  async run(): Promise<void> {
    this.emit("info", "daemon_started", "Monitoring reset credits; automatic redemption is enabled within the configured lead time.");
    while (!this.options.signal?.aborted) {
      const delay = await this.poll(); // Deliberately immediate on startup and after waking.
      if (this.options.signal?.aborted) break;
      try {
        // Node clamps larger delays to 1ms; chunk long Retry-After values instead.
        const until = this.now() + delay;
        while (!this.options.signal?.aborted && this.now() < until) {
          await this.wait(Math.min(MAX_TIMER_MS, until - this.now()), this.options.signal);
        }
      } catch (error) {
        if (!this.options.signal?.aborted) throw error;
      }
    }
    this.emit("info", "daemon_stopped", "Daemon stopped. In-memory attempt history has not been persisted.");
  }
}

export async function runDaemon(options: DaemonOptions = {}, dependencies: DaemonDependencies = {}): Promise<void> {
  await new ResetDaemon(options, dependencies).run();
}
