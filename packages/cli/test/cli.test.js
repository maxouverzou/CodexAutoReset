import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runCli } from "../dist/index.js";

const credentials = { access: "ACCESS_SECRET", refresh: "REFRESH_SECRET", accountId: "ACCOUNT_SECRET", expires: 2000 };
const usage = { planType: "pro", primary: { usedPercent: 82, resetAt: 100, durationSeconds: 18000 }, secondary: null, resetCreditsAvailable: 1 };
const credits = { availableCount: 1, credits: [{ id: "credit-1", resetType: "usage", status: "available", expiresAt: 3000, title: "Reset", description: null }] };
class SafeError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
class ExpiredError extends SafeError {}
function fixture(overrides = {}) {
  let out = "";
  let err = "";
  const calls = [];
  const listeners = new Map();
  const deps = {
    now: () => 1000,
    uuid: () => "11111111-1111-4111-8111-111111111111",
    stdout: text => { out += text; },
    stderr: text => { err += text; },
    readCredentials: async path => { calls.push(["read", path]); return credentials; },
    createClient: value => { calls.push(["client", value]); return {
      getUsage: async () => { calls.push(["usage"]); return usage; },
      listResetCredits: async () => { calls.push(["list"]); return credits; },
      redeemReset: async (...args) => { calls.push(["redeem", ...args]); return { outcome: "reset", windowsReset: 1 }; },
    }; },
    runDaemon: async options => { calls.push(["daemon", options]); },
    isAppError: error => error instanceof SafeError,
    isTokenExpiredError: error => error instanceof ExpiredError,
    onSignal: (signal, listener) => { listeners.set(signal, listener); return () => listeners.delete(signal); },
    ...overrides,
  };
  return { deps, calls, listeners, out: () => out, err: () => err, run: args => runCli(args, deps) };
}
function assertNoSecrets(text) {
  for (const secret of [credentials.access, credentials.refresh, credentials.accountId, "RAW_PAYLOAD"]) {
    assert.ok(!text.includes(secret), `output must omit ${secret}`);
  }
}

test("help and invalid commands never load credentials or use the client", async () => {
  for (const args of [[], ["--help"], ["status", "--help"], ["daemon", "-h"]]) {
    const f = fixture();
    assert.equal(await f.run(args), 0);
    assert.match(f.out(), /Usage:/);
    assert.match(f.out(), /5m/);
    assert.match(f.out(), /15m/);
    assert.deepEqual(f.calls, []);
  }
});

test("strict argument validation is safe and runs before IO", async () => {
  for (const args of [
    ["unknown"], ["status", "extra"], ["resets"], ["resets", "list", "extra"],
    ["resets", "redeem"], ["resets", "redeem", "id", "extra"],
    ["status", "--unknown=ACCESS_SECRET"], ["status", "--auth-file"],
    ["status", "--json=true"], ["status", "--json", "--json"],
    ["status", "--poll-interval", "1m"], ["status", "--redemption-lead-time", "1m"],
    ["daemon", "--poll-interval", "0m"], ["daemon", "--poll-interval", "-1m"],
    ["daemon", "--poll-interval", "Infinitym"], ["daemon", "--poll-interval", "NaNm"],
    ["daemon", "--poll-interval", "1"], ["daemon", "--poll-interval", "0.1ms"],
    ["daemon", "--poll-interval", "999999999999999999999d"],
    ["daemon", "--poll-interval", "8m"], ["daemon", "--redemption-lead-time", "1m"],
  ]) {
    const f = fixture();
    assert.equal(await f.run(args), 2, args.join(" "));
    assert.deepEqual(f.calls, []);
    assertNoSecrets(f.out() + f.err());
  }
});

test("status emits typed usage and no credential or arbitrary payload fields", async () => {
  const f = fixture({ createClient: () => ({ getUsage: async () => ({ ...usage, ...credentials, raw: "RAW_PAYLOAD", primary: { ...usage.primary, raw: "RAW_PAYLOAD" } }) }) });
  assert.equal(await f.run(["--auth-file", "/custom/auth.json", "status", "--json"]), 0);
  assert.deepEqual(JSON.parse(f.out()), { authentication: "authenticated", usage });
  assert.deepEqual(f.calls[0], ["read", "/custom/auth.json"]);
  assertNoSecrets(f.out() + f.err());
});

test("status human output shows health and both usage windows", async () => {
  const f = fixture();
  assert.equal(await f.run(["status"]), 0);
  assert.match(f.out(), /Authentication: authenticated/);
  assert.match(f.out(), /82% used/);
  assert.match(f.out(), /secondary: unavailable/);
  assertNoSecrets(f.out());
});

test("expired credentials fail clearly before network", async () => {
  const f = fixture({ readCredentials: async () => ({ ...credentials, expires: 1000 }) });
  assert.equal(await f.run(["status", "--json"]), 1);
  assert.equal(JSON.parse(f.out()).authentication, "expired");
  assert.match(JSON.parse(f.out()).error.message, /expired/i);
  assert.deepEqual(f.calls, []);
  assertNoSecrets(f.out());
  const human = fixture({ readCredentials: async () => ({ ...credentials, expires: 0 }) });
  assert.equal(await human.run(["status"]), 1);
  assert.match(human.err(), /expired/i);
});

test("remote expiry and safe application errors are distinguished from arbitrary errors", async () => {
  for (const [error, expected] of [
    [new ExpiredError("token_expired", "safe"), /expired/i],
    [new SafeError("auth_read", "Unable to read credentials."), /Unable to read credentials/],
    [new Error("RAW_PAYLOAD ACCESS_SECRET ACCOUNT_SECRET"), /Operation failed/],
    [{ code: "RAW_PAYLOAD", message: "ACCESS_SECRET" }, /Operation failed/],
  ]) {
    const f = fixture({ readCredentials: async () => { throw error; } });
    assert.equal(await f.run(["status", "--json"]), 1);
    assert.match(JSON.parse(f.out()).error.message, expected);
    assertNoSecrets(f.out() + f.err());
  }
});

test("resets list projects typed fields only", async () => {
  const f = fixture({ createClient: () => ({ listResetCredits: async () => ({ ...credits, raw: "RAW_PAYLOAD", credits: credits.credits.map(credit => ({ ...credit, ...credentials })) }) }) });
  assert.equal(await f.run(["resets", "list", "--json", "--auth-file=/override"]), 0);
  assert.deepEqual(JSON.parse(f.out()), credits);
  assert.deepEqual(f.calls[0], ["read", "/override"]);
  assertNoSecrets(f.out());
});

test("explicit redemption uses latest credentials, one UUID, no confirmation, and refreshes", async () => {
  const f = fixture();
  assert.equal(await f.run(["resets", "redeem", "credit-1", "--auth-file", "/auth", "--json"]), 0);
  assert.deepEqual(f.calls.map(call => call[0]), ["read", "client", "redeem", "usage", "list"]);
  assert.deepEqual(f.calls[2], ["redeem", "credit-1", "11111111-1111-4111-8111-111111111111"]);
  assert.deepEqual(JSON.parse(f.out()), { outcome: "reset", windowsReset: 1, refresh: "ok", usage, credits });
  assertNoSecrets(f.out());
  await f.run(["resets", "redeem", "credit-1", "--json"]);
  assert.equal(f.calls.filter(call => call[0] === "read").length, 2);
});

test("default request IDs are fresh UUIDs", async () => {
  const ids = [];
  const f = fixture({ uuid: undefined, createClient: () => ({
    redeemReset: async (_id, requestId) => { ids.push(requestId); return { outcome: "already_redeemed", windowsReset: 0 }; },
    getUsage: async () => usage, listResetCredits: async () => credits,
  }) });
  await f.run(["resets", "redeem", "credit-1"]);
  await f.run(["resets", "redeem", "credit-1"]);
  assert.match(ids[0], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(ids[0], ids[1]);
});

test("successful redemption with failed refresh stays successful and must not be retried", async () => {
  for (const json of [true, false]) {
    for (const failure of ["usage", "list", "both"]) {
      let mutations = 0;
      const f = fixture({ createClient: () => ({
        redeemReset: async () => { mutations++; return { outcome: "reset", windowsReset: 2, raw: "RAW_PAYLOAD" }; },
        getUsage: () => { if (failure !== "list") throw new Error("RAW_PAYLOAD"); return Promise.resolve(usage); },
        listResetCredits: async () => { if (failure !== "usage") throw new Error("RAW_PAYLOAD"); return credits; },
      }) });
      assert.equal(await f.run(["resets", "redeem", "id", ...(json ? ["--json"] : [])]), 0);
      assert.equal(mutations, 1);
      assert.match(f.out(), /Do not repeat redemption/);
      assertNoSecrets(f.out() + f.err());
      if (json) {
        assert.equal(JSON.parse(f.out()).outcome, "reset");
        assert.equal(JSON.parse(f.out()).refresh, "failed");
      }
    }
  }
});

test("all typed redemption outcomes are displayed", async () => {
  for (const outcome of ["reset", "nothing_to_reset", "no_credit", "already_redeemed"]) {
    const f = fixture({ createClient: () => ({ redeemReset: async () => ({ outcome, windowsReset: 0 }), getUsage: async () => usage, listResetCredits: async () => credits }) });
    assert.equal(await f.run(["resets", "redeem", "id", "--json"]), 0);
    assert.equal(JSON.parse(f.out()).outcome, outcome);
  }
});

test("failed redemption is safe and does not refresh or mutate again", async () => {
  let count = 0;
  const f = fixture({ createClient: () => ({ redeemReset: async () => { count++; throw new Error("RAW_PAYLOAD"); } }) });
  assert.equal(await f.run(["resets", "redeem", "id", "--json"]), 1);
  assert.equal(count, 1);
  assertNoSecrets(f.out());
});

test("foreground daemon receives defaults, emits projected JSON events, handles both signals and cleans up", async () => {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const f = fixture();
    f.deps.runDaemon = async options => {
      assert.equal(options.authFile, "/auth");
      assert.equal(options.pollIntervalMs, 300000);
      assert.equal(options.redemptionLeadTimeMs, 900000);
      options.onEvent({ level: "info", code: "started", message: "Monitoring started.", at: 1000, creditId: "id", outcome: "reset", raw: "RAW_PAYLOAD", ...credentials });
      assert.equal(options.signal.aborted, false);
      f.listeners.get(signal)();
      assert.equal(options.signal.aborted, true);
    };
    assert.equal(await f.run(["daemon", "--json", "--auth-file", "/auth"]), 0);
    assert.deepEqual(JSON.parse(f.out()), { level: "info", code: "started", message: "Monitoring started.", at: 1000, creditId: "id", outcome: "reset" });
    assert.equal(f.listeners.size, 0);
    assertNoSecrets(f.out());
    assert.deepEqual(f.calls, []);
  }
});

test("daemon custom durations accept equality and human events", async () => {
  const f = fixture({ runDaemon: async options => {
    assert.equal(options.pollIntervalMs, 500);
    assert.equal(options.redemptionLeadTimeMs, 1000);
    options.onEvent({ at: 1000, level: "warn", code: "waiting", message: "Waiting for credits." });
  } });
  assert.equal(await f.run(["daemon", "--poll-interval=0.5s", "--redemption-lead-time", "1000ms"]), 0);
  assert.match(f.out(), /warn waiting: Waiting for credits/);
  assert.equal(f.listeners.size, 0);
});

test("daemon errors are sanitized and signal listeners are removed", async () => {
  const f = fixture({ runDaemon: async () => { throw new Error("RAW_PAYLOAD"); } });
  assert.equal(await f.run(["daemon", "--json"]), 1);
  assert.equal(f.listeners.size, 0);
  assertNoSecrets(f.out());
});

test("built entry runs only when executed and supports safe subprocess help and validation", () => {
  const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
  const help = spawnSync(process.execPath, [entry, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage:/);
  assert.equal(help.stderr, "");
  const invalid = spawnSync(process.execPath, [entry, "not-a-command", "--json"], { encoding: "utf8" });
  assert.equal(invalid.status, 2);
  assert.equal(JSON.parse(invalid.stdout).error.code, "INVALID_ARGUMENT");
  const imported = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)})`], { encoding: "utf8" });
  assert.equal(imported.status, 0);
  assert.equal(imported.stdout, "");
  assert.equal(imported.stderr, "");
});

test("entry works through package-manager-style bin symlinks", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-cli-test-"));
  try {
    const link = join(directory, "codex-auto-reset");
    symlinkSync(fileURLToPath(new URL("../dist/index.js", import.meta.url)), link);
    const help = spawnSync(process.execPath, [link, "--help"], { encoding: "utf8" });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /Usage:/);
    assert.equal(help.stderr, "");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
