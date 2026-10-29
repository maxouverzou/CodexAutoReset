import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { AppError } from "./errors.js";

export interface Credentials {
  access: string;
  refresh: string;
  /** Pi OAuth expiry, in epoch milliseconds. */
  expires: number;
  accountId: string;
}

function expandHome(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

export function resolveAuthFile(authFile?: string): string {
  if (authFile !== undefined) return expandHome(authFile);
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  return join(agentDir ? expandHome(agentDir) : join(homedir(), ".pi", "agent"), "auth.json");
}

/** Decode only: the remote service, not this check, authenticates the JWT. */
export function validateCredentials(value: unknown): Credentials {
  try {
    const c = value as Credentials;
    if (!c || typeof c !== "object" || typeof c.access !== "string" ||
        !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(c.access) ||
        typeof c.refresh !== "string" || !c.refresh.trim() ||
        typeof c.expires !== "number" || !Number.isFinite(c.expires) ||
        typeof c.accountId !== "string" || !/^[\x21-\x7e]{1,512}$/.test(c.accountId)) throw new Error();
    const payload = JSON.parse(Buffer.from(c.access.split(".")[1]!, "base64url").toString("utf8"));
    if (payload?.["https://api.openai.com/auth"]?.chatgpt_account_id !== c.accountId) throw new Error();
    return { access: c.access, refresh: c.refresh, expires: c.expires, accountId: c.accountId };
  } catch {
    throw new AppError("invalid_credentials", "A valid Pi Codex OAuth credential is required.");
  }
}

/** Read only; never refreshes, writes, executes credential commands, or falls back to Codex auth. */
export async function readCredentials(authFile?: string): Promise<Credentials> {
  let entry: unknown;
  try {
    const content = await readFile(resolveAuthFile(authFile), "utf8");
    const store = JSON.parse(content.replace(/^\uFEFF/, ""));
    entry = store?.["openai-codex"];
  } catch {
    throw new AppError("credential_read_error", "Unable to read Pi OAuth credentials.");
  }
  if (!entry || typeof entry !== "object" || !("type" in entry) || entry.type !== "oauth") {
    throw new AppError("invalid_credentials", "A valid Pi Codex OAuth credential is required.");
  }
  return validateCredentials(entry);
}
