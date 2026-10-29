import { AppError, invalidResponse } from "./errors.js";

export interface UsageWindow {
  usedPercent: number | null;
  /** Unix seconds, as reported by the service (not milliseconds). */
  resetAt: number | null;
  durationSeconds: number | null;
}
export interface UsageSnapshot {
  planType: string | null;
  primary: UsageWindow | null;
  secondary: UsageWindow | null;
  resetCreditsAvailable: number | null;
}
export interface ResetCredit {
  id: string;
  resetType: string;
  status: string;
  /** Epoch milliseconds; null means unknown. */
  expiresAt: number | null;
  title: string | null;
  description: string | null;
}
export interface ResetCreditList { availableCount: number; credits: ResetCredit[] }
export interface RedemptionResult {
  outcome: "reset" | "nothing_to_reset" | "no_credit" | "already_redeemed";
  windowsReset: number;
}

type RecordValue = Record<string, unknown>;
function object(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidResponse();
  return value as RecordValue;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) invalidResponse();
  return value;
}
function optionalText(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string") invalidResponse();
  return value;
}
function number(value: unknown, integer = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 ||
      (integer && !Number.isSafeInteger(value))) invalidResponse();
  return value;
}
function optionalNumber(value: unknown, integer = false): number | null {
  return value == null ? null : number(value, integer);
}
function window(value: unknown): UsageWindow | null {
  if (value == null) return null;
  const w = object(value);
  return {
    usedPercent: optionalNumber(w.used_percent),
    resetAt: optionalNumber(w.reset_at, true),
    durationSeconds: optionalNumber(w.limit_window_seconds, true),
  };
}
export function parseUsage(value: unknown): UsageSnapshot {
  const v = object(value);
  const limits = v.rate_limit == null ? null : object(v.rate_limit);
  const credits = v.rate_limit_reset_credits == null ? null : object(v.rate_limit_reset_credits);
  return {
    planType: optionalText(v.plan_type),
    primary: window(limits?.primary_window),
    secondary: window(limits?.secondary_window),
    resetCreditsAvailable: credits === null ? null : number(credits.available_count, true),
  };
}
function expiry(value: unknown): number | null {
  if (value == null) return null;
  // The official HTTP schema supplies an RFC3339 date-time, not an epoch number.
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) invalidResponse();
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]! ||
      Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 ||
      Number(value.slice(17, 19)) > 59) invalidResponse();
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) invalidResponse();
  return ms;
}
export function parseCredits(value: unknown): ResetCreditList {
  const v = object(value);
  const availableCount = number(v.available_count, true);
  if (!Array.isArray(v.credits)) invalidResponse();
  return { availableCount, credits: v.credits.map((item: unknown) => {
    const c = object(item);
    return {
      id: text(c.id), resetType: text(c.reset_type), status: text(c.status),
      expiresAt: expiry(c.expires_at), title: optionalText(c.title), description: optionalText(c.description),
    };
  }) };
}
export function parseRedemption(value: unknown): RedemptionResult {
  const v = object(value);
  const code = text(v.code);
  if (code !== "reset" && code !== "nothing_to_reset" && code !== "no_credit" && code !== "already_redeemed") {
    throw new AppError("unknown_redemption_outcome", "The service returned an unknown redemption outcome.");
  }
  return { outcome: code, windowsReset: v.windows_reset === undefined ? 0 : number(v.windows_reset, true) };
}
