# CodexAutoReset

Inspect Codex subscription usage and redeem earned reset credits using the `openai-codex` OAuth credentials stored by Pi. The foreground daemon redeems credits that would otherwise expire.

This consumes **earned reset credits**, not purchased usage credits. It cannot force arbitrary quota resets, manufacture credits, or change the natural reset schedule. Backend support and account eligibility are required. The client uses the ChatGPT backend endpoints used by Codex; they are not a promised stable public REST API.

## Build and check

Requires Node.js 22+ and pnpm 10.

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

Tests use synthetic credentials, injected HTTP responses, and temporary files. They do not read your credentials or redeem real credits.

## CLI

The private workspace is not published. Run the built entry point directly:

```sh
node packages/cli/dist/index.js status
node packages/cli/dist/index.js resets list
node packages/cli/dist/index.js resets redeem <credit-id>
node packages/cli/dist/index.js daemon
```

The CLI package also declares the `codex-auto-reset` binary for environments that link/install the workspace package.

- `status`: authentication health and current usage/reset windows.
- `resets list`: reported reset credits, expiry times, and availability count. The backend can return fewer detailed rows than the count; the daemon only acts on explicitly listed credits.
- `resets redeem <credit-id>`: immediately attempt to consume the specified credit, without another confirmation. **This is a real mutation.**
- `daemon`: run until SIGINT/SIGTERM. Starting it enables automatic redemption; there is no separate enablement switch.

Use `--json` for structured output (one event per line for the daemon), and `--help` for options.

```sh
node packages/cli/dist/index.js resets list --json
node packages/cli/dist/index.js daemon --poll-interval 5m --redemption-lead-time 15m
node packages/cli/dist/index.js status --auth-file /path/to/pi/auth.json
```

## Nix package

The flake exports `packages.<system>.codex-auto-reset` (also `default`), matching
`apps` outputs, and `overlays.default`. Supported systems are `x86_64-linux`,
`aarch64-linux`, and `aarch64-darwin`.

```sh
nix build .#codex-auto-reset
./result/bin/codex-auto-reset --help
nix run . -- status
nix run . -- resets list --json
```

The package builds TypeScript and runs the fixture tests in the Nix sandbox. Its
runtime includes Node and the compiled workspace packages, not a checkout,
`tsx`, or development dependencies. `nix flake check` also checks the Home Manager
module on Linux. After changing dependency versions or the lockfile, regenerate
`pnpmDeps.hash` in `nix/package.nix` using the usual fixed-output hash workflow.

### Home Manager systemd user service (Linux)

Add this flake as an input, then import its module in your Home Manager configuration:

```nix
# In your flake inputs:
inputs.codex-auto-reset.url = "github:maxouverzou/CodexAutoReset";

# In a Home Manager module, with your flake inputs passed to the module:
{ inputs, ... }:
{
  imports = [ inputs.codex-auto-reset.homeManagerModules.default ];

  services.codex-auto-reset = {
    enable = true;
    pollInterval = 300;       # seconds
    redemptionLeadTime = 900; # seconds

    # Optional runtime filename: a STRING, never a Nix path literal or file contents.
    # authFile = "/home/alice/.pi/agent/auth.json";
  };
}
```

The module installs the CLI and defines `codex-auto-reset.service`, wanted by the
user's `default.target`, with restart-on-failure. `package` can override the
bundled package. Enabling the service **authorizes automatic redemption** under
the expiry policy; it does not just enable monitoring. Timing settings are
validated at evaluation time.

The example input and Home Manager module are separate snippets, not a complete
flake. For standalone Home Manager, pass `extraSpecialArgs = { inherit inputs; };`
to `homeManagerConfiguration`; for Home Manager in NixOS, use
`home-manager.extraSpecialArgs = { inherit inputs; };`.

After applying your Home Manager configuration:

```sh
systemctl --user start codex-auto-reset.service
systemctl --user status codex-auto-reset.service
journalctl --user -u codex-auto-reset.service -f
```

The user manager may not inherit `PI_CODING_AGENT_DIR` from your interactive shell;
set `authFile` explicitly if Pi uses a nondefault directory. Do **not** use
`authFile = /home/alice/.pi/agent/auth.json;`, `builtins.readFile`, or embed tokens
in Nix configuration: that could copy secrets into the publicly readable store.
The module only passes the filename at runtime and does not provision credentials.
Pi still owns token refresh. The service runs while the systemd user manager is
running; running after logout requires separately configured user lingering.
This module does not enable lingering or modify the system automatically.

## Credentials

Resolution order:

1. Explicit `--auth-file`.
2. `auth.json` under `PI_CODING_AGENT_DIR`.
3. `~/.pi/agent/auth.json`.

Only the `openai-codex` OAuth entry is supported. The client verifies consistency between the stored account ID and the access token's account claim; decoding that claim is not signature verification. Authentication remains the backend's responsibility.

This version **never refreshes tokens or writes the credential file**. Pi must perform login and refresh. The daemon warns if the token is expired, skips authenticated requests for that poll, and re-reads the file on subsequent polls so it can recover when Pi updates it. Missing/malformed credentials and network failures also do not stop the daemon.

There is no automatic import of Codex CLI's `~/.codex/auth.json`, `pi-accounts`, API keys, or Pi runtime overrides. A raw file read is not equivalent to resolving the active Pi session's authentication. Credentials and raw backend errors are never printed.

## Automatic redemption policy

- Check immediately on startup; do not wait for the first interval.
- Poll every **5 minutes**, with a **15-minute redemption lead time**, by default.
- The polling interval must be positive and no greater than half the lead time. Invalid settings fail at startup.
- Fetch fresh credit details each poll. Never redeem from a stale listing after a fetch failure.
- Choose the earliest-expiring available `codex_rate_limits` credit within its lead time. Require an explicit credit ID and a known, future expiry.
- Send at most one redemption request per poll, including retries. Fetch fresh state again before considering another credit on a later poll.
- Follow account changes in the configured credential file. Re-read credentials before POST and defer if the account changed during the poll.
- Respect server `Retry-After` delays. Redemption is best-effort: sleep, downtime, rate limits, network failures, or expired authentication can cause a credit to expire unused.

### Outcomes and retry limits

The daemon keeps attempt UUIDs and outcome history **in memory only**:

| Outcome | Behavior |
| --- | --- |
| `reset` / `already_redeemed` | Record completion; refresh server usage and credits. A failed refresh does not undo a successful mutation. |
| `nothing_to_reset` | Suppress that credit until process restart. |
| `no_credit` | Refresh details; do not immediately issue another POST. |
| Transport failure | Outcome is uncertain; reuse the same UUID for that account/credit on a later eligible poll. |
| Unrecognized response | Warn and suppress that credit until restart. |
| Credit expires | Stop redemption attempts; warn if an earlier attempt remains uncertain. |

There is no durable journal or shared lock. Restarting loses attempt IDs and suppression history. Separate CLI/daemon instances and other machines are not coordinated. A fresh listing cannot prove that a previous timed-out request is no longer in flight. Avoid running multiple redeeming instances against the same account if this uncertainty is unacceptable. Stopping the process does not cancel a mutation already accepted by the server.

## Workspace

- `packages/core`: credential reading/validation, usage snapshots, credit listing, redemption HTTP client.
- `packages/daemon`: scheduling, account-bound in-memory attempts, outcome policies and lifecycle.
- `packages/cli`: command parsing and human/JSON output.

Primary-source protocol and authentication research is in [`docs/research`](docs/research).
