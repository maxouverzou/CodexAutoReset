#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import type {
  Credentials, UsageWindow, UsageSnapshot as Usage, ResetCreditList as Credits,
  CodexClient,
} from "@codex-auto-reset/core";
import type { DaemonOptions } from "@codex-auto-reset/daemon";

type Client = Pick<CodexClient, "getUsage" | "listResetCredits" | "redeemReset">;
/** Overrides allow embedding and testing without reading auth files or making requests. */
export interface CliDependencies {
  readCredentials: (authFile?: string) => Promise<Credentials>;
  createClient: (credentials: Credentials) => Client;
  runDaemon: (options: DaemonOptions) => Promise<void>;
  isAppError: (error: unknown) => error is Error & { code: string };
  isTokenExpiredError: (error: unknown) => boolean;
  now: () => number;
  uuid: () => string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  onSignal: (signal: "SIGINT" | "SIGTERM", listener: () => void) => () => void;
}

const HELP = `Usage: codex-auto-reset <command> [options]

Commands:
  status                       Show authentication health and usage
  resets list                  List reset credits
  resets redeem <credit-id>    Redeem a credit immediately (no confirmation)
  daemon                       Run the foreground automatic reset daemon

Options:
  --auth-file <path>            Override the credentials file (all commands)
  --json                       Emit JSON (daemon emits one object per line)
  --poll-interval <duration>    Daemon polling interval (default: 5m)
  --redemption-lead-time <duration>
                               Daemon lead time (default: 15m)
  --help, -h                   Show this help

Durations: positive number followed by ms, s, m, h, or d.
Daemon polling must be no more than half the lead time.
`;
const TIMER_MAX = 2_147_483_647;
class ArgumentError extends Error {}

function duration(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(value);
  if (!match) throw new ArgumentError("Invalid duration; use a positive number with ms, s, m, h, or d.");
  const factors: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const result = Number(match[1]) * factors[match[2]!]!;
  if (!Number.isFinite(result) || result < 1 || result > TIMER_MAX) {
    throw new ArgumentError("Duration must be at least 1ms and at most 2147483647ms.");
  }
  return result;
}

function parse(args: string[]) {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  const values = new Set(["--auth-file", "--poll-interval", "--redemption-lead-time"]);
  let positionalOnly = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (positionalOnly) { positional.push(arg); continue; }
    if (arg === "--") { positionalOnly = true; continue; }
    if (!arg.startsWith("-")) { positional.push(arg); continue; }
    const equals = arg.indexOf("=");
    const name = (equals < 0 ? arg : arg.slice(0, equals)) === "-h"
      ? "--help" : equals < 0 ? arg : arg.slice(0, equals);
    if (!values.has(name) && name !== "--json" && name !== "--help") {
      throw new ArgumentError("Unknown option. Use --help for usage.");
    }
    if (flags.has(name)) throw new ArgumentError("Duplicate option. Use each option only once.");
    if (values.has(name)) {
      const value = equals < 0 ? args[++i] : arg.slice(equals + 1);
      if (!value || value.startsWith("-")) throw new ArgumentError("Option requires a value. Use --help for usage.");
      flags.set(name, value);
    } else {
      if (equals >= 0) throw new ArgumentError("Boolean options do not accept a value.");
      flags.set(name, true);
    }
  }
  const help = flags.has("--help") || args.length === 0;
  const [command, action, creditId] = positional;
  if (!help) {
    const valid = (command === "status" || command === "daemon") ? positional.length === 1
      : command === "resets" && (action === "list" ? positional.length === 2
        : action === "redeem" && positional.length === 3 && !!creditId?.trim());
    if (!valid) throw new ArgumentError("Invalid command or arguments. Use --help for usage.");
    if (command !== "daemon" && (flags.has("--poll-interval") || flags.has("--redemption-lead-time"))) {
      throw new ArgumentError("Timing options are only valid for daemon.");
    }
  }
  const pollIntervalMs = duration(String(flags.get("--poll-interval") ?? "5m"));
  const redemptionLeadTimeMs = duration(String(flags.get("--redemption-lead-time") ?? "15m"));
  if (pollIntervalMs > redemptionLeadTimeMs / 2) {
    throw new ArgumentError("Polling interval must be no more than half the redemption lead time.");
  }
  return { command, action, creditId, help, json: flags.has("--json"),
    authFile: flags.get("--auth-file") as string | undefined, pollIntervalMs, redemptionLeadTimeMs };
}

function projectUsage(usage: Usage): Usage {
  const window = (value: UsageWindow | null): UsageWindow | null => value === null ? null : ({
    usedPercent: value.usedPercent, resetAt: value.resetAt, durationSeconds: value.durationSeconds,
  });
  return { planType: usage.planType, primary: window(usage.primary), secondary: window(usage.secondary),
    resetCreditsAvailable: usage.resetCreditsAvailable };
}
function projectCredits(list: Credits): Credits {
  return { availableCount: list.availableCount, credits: list.credits.map(credit => ({
    id: credit.id, resetType: credit.resetType, status: credit.status, expiresAt: credit.expiresAt,
    title: credit.title, description: credit.description,
  })) };
}
function timestamp(milliseconds: number | null): string {
  if (milliseconds === null) return "unknown";
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "unknown";
}
function usageText(usage: Usage): string {
  const lines = [`Plan: ${usage.planType ?? "unknown"}`];
  for (const name of ["primary", "secondary"] as const) {
    const value = usage[name];
    lines.push(`${name}: ${value ? `${value.usedPercent ?? "unknown"}% used; resets at ${timestamp(value.resetAt === null ? null : value.resetAt * 1000)}; duration ${value.durationSeconds ?? "unknown"}s` : "unavailable"}`);
  }
  lines.push(`Reset credits available: ${usage.resetCreditsAvailable ?? "unknown"}`);
  return lines.join("\n");
}

/** Returns an exit code; importing this module does not run the CLI. */
export async function runCli(args = process.argv.slice(2), overrides: Partial<CliDependencies> = {}): Promise<number> {
  const stdout = overrides.stdout ?? (text => { process.stdout.write(text); });
  const stderr = overrides.stderr ?? (text => { process.stderr.write(text); });
  let json = args.includes("--json");
  let deps: CliDependencies | undefined;
  const describe = (error: unknown) => {
    if (error instanceof ArgumentError) return { code: "INVALID_ARGUMENT", message: error.message };
    if (deps?.isTokenExpiredError(error)) return { code: "TOKEN_EXPIRED", message: "Authentication expired. Open Pi to refresh its credentials before continuing." };
    if (deps?.isAppError(error)) return { code: error.code, message: error.message };
    return { code: "CLI_ERROR", message: "Operation failed. Check authentication and connectivity before trying again." };
  };
  try {
    const options = parse(args);
    json = options.json;
    if (options.help) { stdout(HELP); return 0; }
    // Load operational dependencies only for commands, never for help/argument validation.
    let core: typeof import("@codex-auto-reset/core") | undefined;
    if (!overrides.readCredentials || !overrides.createClient || !overrides.isAppError || !overrides.isTokenExpiredError) {
      core = await import("@codex-auto-reset/core");
    }
    deps = {
      readCredentials: overrides.readCredentials ?? core!.readCredentials,
      createClient: overrides.createClient ?? (credentials => new core!.CodexClient(credentials)),
      isAppError: overrides.isAppError ?? ((error): error is Error & { code: string } => error instanceof core!.AppError),
      isTokenExpiredError: overrides.isTokenExpiredError ?? (error => error instanceof core!.TokenExpiredError),
      runDaemon: overrides.runDaemon ?? (async daemonOptions => {
        const { runDaemon } = await import("@codex-auto-reset/daemon");
        return runDaemon(daemonOptions);
      }),
      now: overrides.now ?? Date.now,
      uuid: overrides.uuid ?? randomUUID,
      stdout, stderr,
      onSignal: overrides.onSignal ?? ((signal, listener) => {
        process.on(signal, listener);
        return () => { process.off(signal, listener); };
      }),
    };
    if (options.command === "daemon") {
      const controller = new AbortController();
      const stop = () => controller.abort();
      const removeInt = deps.onSignal("SIGINT", stop);
      const removeTerm = deps.onSignal("SIGTERM", stop);
      try {
        await deps.runDaemon({
          ...(options.authFile === undefined ? {} : { authFile: options.authFile }),
          pollIntervalMs: options.pollIntervalMs, redemptionLeadTimeMs: options.redemptionLeadTimeMs,
          signal: controller.signal,
          onEvent: event => {
            const safe = { level: event.level, code: event.code, message: event.message, at: event.at,
              ...(event.creditId === undefined ? {} : { creditId: event.creditId }),
              ...(event.outcome === undefined ? {} : { outcome: event.outcome }) };
            stdout(json ? `${JSON.stringify(safe)}\n` : `[${new Date(safe.at).toISOString()}] ${safe.level} ${safe.code}: ${safe.message}\n`);
          },
        });
      } finally { removeInt(); removeTerm(); }
      return 0;
    }
    // Read at invocation time, including for each explicit redemption; never cache credentials.
    const credentials = await deps.readCredentials(options.authFile);
    if (!Number.isFinite(credentials.expires) || credentials.expires <= deps.now()) {
      const error = { code: "TOKEN_EXPIRED", message: "Authentication expired. Open Pi to refresh its credentials before continuing." };
      if (json) stdout(`${JSON.stringify({ ...(options.command === "status" ? { authentication: "expired" } : {}), error })}\n`);
      else stderr(`${error.message}\n`);
      return 1;
    }
    const client = deps.createClient(credentials);
    if (options.command === "status") {
      const usage = projectUsage(await client.getUsage());
      stdout(json ? `${JSON.stringify({ authentication: "authenticated", usage })}\n` : `Authentication: authenticated\n${usageText(usage)}\n`);
    } else if (options.action === "list") {
      const list = projectCredits(await client.listResetCredits());
      stdout(json ? `${JSON.stringify(list)}\n` : `Available reset credits: ${list.availableCount}\n${list.credits.map(credit => `${credit.id}: ${credit.status}; type ${credit.resetType}; expires ${timestamp(credit.expiresAt)}${credit.title ? `; ${credit.title}` : ""}${credit.description ? `; ${credit.description}` : ""}`).join("\n")}${list.credits.length ? "\n" : ""}`);
    } else {
      const result = await client.redeemReset(options.creditId!, deps.uuid());
      // Mutation is complete. Refresh errors must never be reported as a failed redemption.
      const [usage, credits] = await Promise.allSettled([
        Promise.resolve().then(() => client.getUsage()).then(projectUsage),
        Promise.resolve().then(() => client.listResetCredits()).then(projectCredits),
      ]);
      const refreshFailed = usage.status === "rejected" || credits.status === "rejected";
      const report = {
        outcome: result.outcome, windowsReset: result.windowsReset,
        refresh: refreshFailed ? "failed" : "ok",
        ...(usage.status === "fulfilled" ? { usage: usage.value } : {}),
        ...(credits.status === "fulfilled" ? { credits: credits.value } : {}),
        ...(refreshFailed ? { warning: "Redemption completed, but refreshing usage or credits failed. Do not repeat redemption; use status or resets list to refresh." } : {}),
      };
      stdout(json ? `${JSON.stringify(report)}\n` : `Redemption completed: ${report.outcome}; windows reset: ${report.windowsReset}.\n${report.warning ?? usageText(usage.status === "fulfilled" ? usage.value : { planType: null, primary: null, secondary: null, resetCreditsAvailable: null })}\n`);
    }
    return 0;
  } catch (error) {
    const safe = describe(error);
    if (json) stdout(`${JSON.stringify({ ...(safe.code === "TOKEN_EXPIRED" ? { authentication: "expired" } : {}), error: safe })}\n`);
    else stderr(`${safe.message}\n`);
    return error instanceof ArgumentError ? 2 : 1;
  }
}

function isEntryPoint(): boolean {
  if (!process.argv[1]) return false;
  try {
    // Package-manager bin links can differ from the module's canonical path.
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch { return false; }
}
if (isEntryPoint()) {
  process.exitCode = await runCli();
}
