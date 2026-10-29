/** Shared read-only Pi authentication and account-bound Codex HTTP client. */
export const PACKAGE_NAME = "@codex-auto-reset/core";
export { readCredentials, resolveAuthFile, type Credentials } from "./auth.js";
export { AppError, HttpError, TokenExpiredError } from "./errors.js";
export { CodexClient } from "./client.js";
export type { UsageWindow, UsageSnapshot, ResetCredit, ResetCreditList, RedemptionResult } from "./schema.js";
