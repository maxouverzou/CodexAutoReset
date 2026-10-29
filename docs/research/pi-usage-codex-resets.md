# Codex usage inspection and earned quota-reset redemption

## Audit scope and local conventions

Audited **2026-10-29 UTC** (public checkouts fetched at approximately 17:48 UTC). This is factual research, not an implementation or a live account test.

- `narumiruna/pi-extensions`, default-branch commit **`8521e139d26ac96dcce1470aeaf6bb305ccdd656`** (commit date `2026-10-30T01:00:00+08:00`, i.e. October 29 UTC).
- `openai/codex`, default-branch commit **`03b7e22f9448469f0834ca05a12a1a92ddc52f3a`** (commit date `2026-10-29T17:35:44Z`). All GitHub citations below are pinned to these commits; behavior in older installed releases may differ.
- Local CodexAutoReset HEAD: **`e6c614b5a3709e7c7145a5ab1c10da49370f20e8`**. Inspected local instructions before researching: the supplied `/var/lib/t3/.pi/agent/AGENTS.md` prefers pnpm, and `.agents/skills/research/SKILL.md` requires primary-source research captured in one Markdown note. No repository `AGENTS.md` or existing research-note directory was found. Therefore this note uses the requested fallback path.
- Local conventions observed: private pnpm 10 TypeScript workspace, `packages/core`, `packages/cli`, and `packages/daemon`; root `build`, `clean`, and `typecheck` scripts. The three `src/index.ts` files are scaffolding, not an existing quota/reset implementation. Existing staged/unrelated changes were left alone.
- Read the installed Pi README and the complete applicable `docs/extensions.md`, `packages.md`, `custom-provider.md`, `configuration.md`, and `settings.md`, including relevant linked configuration/authentication guidance. Installed documentation root: `/nix/store/6p54359amf2yif1bf9wzgxg134kvvily-pi-coding-agent-1.3.0/lib/node_modules/pi-monorepo/`. This is a local documentation snapshot, **not** a verified upstream Pi Git commit. No UI implementation is proposed here.

Only public source and public OpenAI documentation were retrieved. No real credential store, environment secrets, or account data was read; no authenticated request, token refresh, reset redemption, or model generation was performed. Example payloads below are synthetic/source-derived, not captured production traffic.

## Executive finding

**Usage inspection is available, and an actual quota-reset redemption operation exists in both the audited extension and OpenAI's own Codex client.** It is not an unrestricted “force reset”: it consumes an **earned reset credit** for an eligible account/window. The primary owning evidence is OpenAI's backend client and account protocol, not the third-party extension's description.[O1][O2][O3]

The extension's `/usage` refresh and its **Redeem usage limit reset…** action are different operations. A countdown reaching zero, an OAuth token refreshing, or a new conversation starting is not equivalent to redeeming a quota reset.[P1][P2][P3][O3][O6][D2]

No audited source establishes a way to reset arbitrary server limits without credit/eligibility, manufacture credits, force a fresh window by sending a prompt, or alter the server's reset schedule. Do not implement any of those as established capabilities.

## 1. Operations that must not be conflated

| Operation | What the evidence supports | What it does not establish |
| --- | --- | --- |
| Refresh usage | GET a fresh server usage snapshot; normalize percentages and reset timestamps. `/usage` refresh does this.[P1][P2] | No quota-reset mutation or credit consumption. |
| Natural server quota reset | Server reports a rolling-window duration and reset timestamp. Local countdowns display that information.[O4][O5] | A client timer cannot itself reset quota. Elapsed time is not proof that ordinary usage is now allowed.[O3] |
| Start/consume a usage window | Ordinary tasks consume allowance; model, context, tools, and caching affect the amount.[D1] | Exact first-use anchoring/re-anchoring rules are not specified by the inspected client code/docs. No evidence that a usage GET or “ping” starts a useful new window. |
| Redeem earned quota reset | POST consumes an earned reset credit; `reset` means eligible rate-limit windows were reset.[O1][O3] | Not unlimited; not necessarily every quota; eligibility is backend-owned. |
| Refresh OAuth token | Renews authentication. Codex documents automatic token refresh, separately from usage accounting.[D2] | Not replenishment of subscription allowance. |
| Reset conversation | Codex `/new` starts a new chat; `/clear` clears the terminal and starts a new chat.[O6] | Not an account quota reset. A new chat may affect future task/context size, not restore consumed allowance. |
| Force arbitrary quota reset | No such general operation was found in the audited surfaces. | Do not turn this bounded negative result into a claim that no private backend capability can exist. |

The current official pricing page describes five-hour estimates for some plans, says weekly limits may apply, and points to the usage dashboard for actual limits/reset times. It also describes plans without the same five-hour constraint. Consequently **do not hard-code “primary = 5h, secondary = week” for every account**.[D1] OpenAI's protocol explicitly says a null `ordinaryUsageAllowed` is unavailable and clients must not infer recovery from percentages or reset times.[O3]

## 2. Retrieving usage and reset times

### HTTP request

The audited `openai-codex` extension adapter calls:[P1]

```http
GET /backend-api/wham/usage HTTP/1.1
Host: chatgpt.com
Authorization: Bearer <resolved ChatGPT OAuth access token>
User-Agent: pi-usage
```

Important fidelity detail: the extension's generic Codex usage-auth path constructs an `Authorization` header; it does **not** add `chatgpt-account-id` in that generic path. Its **reset** auth path explicitly adds that header. Do not assume these paths are identical.[P4][P3] OpenAI's client auth supports both bearer authorization and account selection; a new account-sensitive integration should preserve the account identifier supplied by its owning authentication provider rather than copying this omission.[O7]

OpenAI's owning backend client confirms GET usage, and supports two URL styles:[O1]

- ChatGPT backend: base `https://chatgpt.com/backend-api`, suffix `/wham/usage`.
- Codex API style: configured base plus `/api/codex/usage`.

The second style is a client routing option, **not evidence that substituting `https://api.openai.com` with an ordinary API key gives access to ChatGPT subscription quotas**. The official pricing page distinguishes subscription usage from API-key billing.[D1]

### Response shape

Illustrative relevant subset (optional fields can be absent/null; unknown fields may exist):

```json
{
  "plan_type": "plus",
  "rate_limit": {
    "allowed": true,
    "limit_reached": false,
    "primary_window": {
      "used_percent": 37,
      "limit_window_seconds": 18000,
      "reset_after_seconds": 7200,
      "reset_at": 1793304000
    },
    "secondary_window": {
      "used_percent": 61,
      "limit_window_seconds": 604800,
      "reset_after_seconds": 345600,
      "reset_at": 1793642400
    }
  },
  "additional_rate_limits": [],
  "credits": { "has_credits": false, "unlimited": false, "balance": "0" },
  "rate_limit_reset_credits": { "available_count": 2 }
}
```

The enclosing usage and rate-limit object fields are owned by OpenAI's generated [usage payload model](https://github.com/openai/codex/blob/03b7e22f9448469f0834ca05a12a1a92ddc52f3a/codex-rs/codex-backend-openapi-models/src/models/rate_limit_status_payload.rs#L15-L53) and [limit-details model](https://github.com/openai/codex/blob/03b7e22f9448469f0834ca05a12a1a92ddc52f3a/codex-rs/codex-backend-openapi-models/src/models/rate_limit_status_details.rs#L15-L34). The generated OpenAI window model owns `used_percent`, `limit_window_seconds`, `reset_after_seconds`, and `reset_at`; OpenAI maps `reset_at` into protocol `resets_at`, documented as **Unix seconds**.[O4][O5] Convert to JavaScript milliseconds only at a `Date` boundary (`reset_at * 1000`), not in persisted wire data.

The extension:[P2]

- Normalizes `rate_limit.primary_window` and `secondary_window`, plus optional `additional_rate_limits` groups identified by `metered_feature` or `limit_name`.
- Treats `used_percent` as percentage used; computes remaining as `100 - clamp(used, 0, 100)`.
- Converts positive window seconds to minutes and carries `reset_at` through as `resetsAt`.
- Reports `credits` separately from `rate_limit_reset_credits.available_count`.

**Purchased/general usage credits and earned reset credits are distinct fields and actions.** A credit balance is not proof of a redeemable reset. Conversely, a usage-summary reset count is not a complete listing of the selectable credits.[O2][O3][P2]

## 3. Applying a reset: a real but conditional mutation

### List reset credits

```http
GET /backend-api/wham/rate-limit-reset-credits HTTP/1.1
Host: chatgpt.com
Authorization: Bearer <access token>
chatgpt-account-id: <matched account id>
```

Source-derived example:

```json
{
  "available_count": 2,
  "credits": [
    {
      "id": "opaque-credit-id",
      "reset_type": "codex_rate_limits",
      "status": "available",
      "granted_at": "2026-06-17T00:00:00Z",
      "expires_at": "2026-07-17T00:00:00Z",
      "title": "Full reset (Weekly + 5 hr)",
      "description": "Ready to redeem"
    }
  ]
}
```

OpenAI's model owns these fields; its test supplies the sample title and response structure.[O2][O8] The title is **fixture/backend-provided display text**, not a universal guarantee that every redemption resets both weekly and five-hour windows. The account protocol says detail lists may be capped and shorter than `availableCount`; null details mean only the count is known.[O3]

The extension filters available `codex_rate_limits` credits, sorts expiring credits first, and caps options at 32. It can offer a generic reset if a positive count exists but no detailed option is available; the menu can also fall back to a positive usage-summary count when detail retrieval fails. These are extension fallback policies, not proof of fresh eligibility.[P3][P5]

### Consume one earned reset

**Do not issue this request merely to inspect availability.** It is the quota-changing operation:

```http
POST /backend-api/wham/rate-limit-reset-credits/consume HTTP/1.1
Host: chatgpt.com
Authorization: Bearer <access token>
chatgpt-account-id: <matched account id>
Content-Type: application/json

{
  "redeem_request_id": "<UUID for one logical attempt>",
  "credit_id": "<selected opaque credit id>"
}
```

`credit_id` is optional. When omitted, OpenAI's account protocol says the backend selects the next available credit. Both extension and upstream backend client serialize `redeem_request_id` and optional `credit_id`; this is a JSON body field, not an invented `Idempotency-Key` HTTP header.[P3][O1][O3]

Example response:

```json
{ "code": "reset", "windows_reset": 2 }
```

The backend model recognizes four snake_case outcomes:[O2][O3]

- `reset`: a credit was consumed and eligible rate-limit windows reset.
- `nothing_to_reset`: no current window is eligible.
- `no_credit`: the account has no earned reset credits available.
- `already_redeemed`: the same idempotency key already completed successfully.

`windows_reset` is an integer count, defaulting to zero when omitted in the upstream deserializer; it does not identify which buckets were changed. Refresh usage after redemption rather than zeroing all local percentages by assumption.[O2][P5]

The extension requires a current `openai-codex` model, fresh account matching, selection and explicit confirmation. Before POST it re-resolves authentication and checks model identity and auth fingerprint. It preserves the same UUID for “Try again” after uncertain transport failure, then invalidates/refetches usage for the still-current account.[P3][P5] A dropped connection, timeout, or local abort **cannot prove the server did not redeem the credit**; preserving the attempt ID is essential. The extension's ID lives in menu state, so durable cross-process retry safety would need stronger persistence than this UI implementation.[P5]

### First-party app-server surface

The audited OpenAI app-server protocol also exposes:[O9][O3]

```json
{"id":1,"method":"account/rateLimits/read","params":{"excludeResetCreditDetails":true}}
```

The result includes `rateLimits`, optional `rateLimitsByLimitId`, `rateLimitResetCredits`, `accountId`, and `ordinaryUsageAllowed`. Omit or set `excludeResetCreditDetails: false` for detailed reset-credit reads. For a passive monitor, do not enable `supportsLunaReserve`: the protocol says it can permit experiment-exposure recording, and the backend client reserves opt-in for clients capable of applying Reserve.[O1][O3]

```json
{"id":2,"method":"account/rateLimitResetCredit/consume","params":{"idempotencyKey":"<same UUID on retry>","creditId":"<opaque id>"}}
```

Example result: `{"outcome":"reset"}`. Outcomes use **camelCase** (`nothingToReset`, `noCredit`, `alreadyRedeemed`) here, unlike HTTP snake_case. The app-server response does not expose `windows_reset`. The request processor rejects empty IDs, requires Codex-backend/ChatGPT authentication, maps to the same backend mutation, and uses a ten-second timeout.[O3][O10]

These are protocol examples, **not** a complete standalone invocation recipe: the app-server transport must first be initialized according to the installed release's protocol. Source existence at the audited main commit does not prove availability in the user's installed Codex binary.

## 4. Authentication ownership and security

### What the extension actually uses

It resolves active runtime auth through Pi's model registry (`getApiKeyAndHeaders` / `getProviderAuth`), rejects custom/proxy origins before sending credentials to the official endpoint, and fingerprints resolved identity.[P4] For reset mutation it additionally:[P3][P6]

1. Requires the current model's provider to be `openai-codex`.
2. Waits for compatible credential sources to be ready; obtains OAuth candidates through the extension credential-source channel plus Pi's stored-credential fallback.
3. Matches the **exact resolved access token** against a candidate with nonempty refresh token and valid stored `accountId`.
4. Checks stored account ID against the access token's `https://api.openai.com/auth.chatgpt_account_id` claim.
5. Rejects conflicting matches or account/model changes; sends `Authorization` and `chatgpt-account-id`.

JWT payload decoding here is an identity-consistency check, **not cryptographic JWT verification**. Server authentication remains authoritative. The refresh token is used to qualify/match a credential locally, not sent to either usage or redemption endpoints.[P3]

Pi's installed `custom-provider.md` documents default OAuth storage in `~/.pi/agent/auth.json`; `configuration.md` documents that the agent directory can be overridden. **This is not Codex CLI's credential store.** OpenAI documents Codex file/keyring/auto/ephemeral storage, with file storage under `CODEX_HOME` (default `~/.codex/auth.json`) and automatic token refresh during active use.[D2] Do not assume a file exists or manually copy another process's refresh token as an integration design.

### Recommendations, not claims about backend guarantees

- Prefer an installed, version-checked first-party app-server integration for a CLI/daemon if it supports these account methods; it can keep credential refresh/storage ownership inside Codex. Treat its local RPC channel as privileged: the consume method itself is not an interactive confirmation policy.
- If integrating directly with HTTP, make the credential source explicit, account-bound and opt-in. Do not silently mix Pi credentials, Codex credentials, API keys, proxy headers or different workspaces.
- Fail closed on mismatches; bind pending reset confirmation/attempts to account and selected credit. Re-resolve before mutation; invalidate caches on account changes.
- Never log raw access/refresh tokens, Authorization headers, full JWTs or complete provider payloads. Redact account IDs and opaque credit IDs from routine telemetry. Treat credential files and persisted attempt state as sensitive.
- Restrict destinations to approved HTTPS origins; reject redirects **before following them**. The extension's shared fetch helper checks `response.redirected` after fetch and only sets a redirect policy when requested. Do not mistake that post-response check for a preflight guarantee; use `redirect: "error"` in a new direct client.[P7]
- Do not put redemption behind ordinary usage refresh or automatically consume credits by default. Require explicit consent or a narrowly defined, durable user-approved automation policy with single-flight locking and an audit trail.
- Persist one logical attempt ID with account/credit binding before POST; reuse it across transport retries/restarts. A timeout should produce an uncertain state, not a new attempt ID. Do not claim cancellation reverses a successful redemption.

Pi's installed extension documentation warns that extensions run with the host process's OS permissions and can read credentials. Its lifecycle guidance starts timers/resources at session start or command use and disposes them at shutdown; follow that if a future Pi integration adds polling. The present repo is CLI/daemon scaffolding, so Pi APIs should not be imposed on the shared core merely because this research started from a Pi extension.

## 5. Implementation direction for CodexAutoReset

These are design recommendations; no code was changed.

1. **Resolve the product meaning first:** choose between (a) monitor/notify/resume after a naturally reported reset and (b) opt-in redemption of an earned reset credit. Call the latter `redeemEarnedReset`, not generic `applyReset` or `forceReset`.
2. Put transport-independent usage snapshots, timestamp conversion, per-bucket identity, account binding, and outcome types in `packages/core`. Keep CLI consent/display and daemon polling/persistence separate. Preserve unknown/absent fields rather than interpreting missing data as zero usage or unlimited allowance.
3. Make polling read-only by default; back off on errors, respect auth failures, and distinguish stale/unknown data from “quota available.” Requery at/after a reported reset; do not send a paid/model request just to “activate” it. No inspected source establishes that activation is needed.
4. Where the installed protocol offers it, gate automatic resumption on authoritative `ordinaryUsageAllowed === true`, not a percentage/countdown alone. Never treat null as permission. Explicitly reconcile account identity before acting.[O3]
5. Model redemption outcomes separately from network failure and post-redemption-refresh failure. Surface credit expiry and backend description, but do not promise exact windows based on text alone. Get a fresh snapshot after a successful/already-redeemed response.
6. Test with synthetic fixtures: absent windows, unusual durations, extra model buckets, malformed timestamps, account switches, no credits, expired/unavailable rows, all four outcomes, unknown outcome, POST timeout followed by same-ID retry, daemon restart, concurrency, and success followed by failed usage refresh. Do not exercise mutations against a real account in routine tests.

### Remaining uncertainties / limits

- Source proves **client-supported protocol**, not deployment-wide availability or this user's entitlement. No authenticated production verification was done.
- The backend service is not published here. Exact window eligibility, reset amounts/re-anchoring, credit issuance, expiration enforcement, rollout, and idempotency retention duration remain server-owned/unknown. The audited client does not justify promising an unlimited forced reset.
- Current public pricing discusses invitations and plan-specific rewards, but it is not a stable universal specification for issuing reset credits. Do not automate invitation/reward generation or assume every account can earn credits.[D1]
- Natural-window first-use timing is not established by these sources. “Rolling window” and an observed timestamp are insufficient to claim that sending a message at a chosen time creates a desired reset schedule.[O5]
- HTTP endpoints are used by OpenAI's client, but no inspected public document promises them as a stable general-purpose subscription-management REST API. Pin/test versions and expect schema/eligibility changes.

## Sources

### OpenAI-owned source (permanent)

[O1]: https://github.com/openai/codex/blob/03b7e22f9448469f0834ca05a12a1a92ddc52f3a/codex-rs/backend-client/src/client/rate_limit_resets.rs#L15-L155
[O2]: https://github.com/openai/codex/blob/03b7e22f9448469f0834ca05a12a1a92ddc52f3a/codex-rs/backend-client/src/types.rs#L22-L118
[O3]: https://github.com/openai/codex/blob/03b7e22f9448469f0834ca05a12a1a92ddc52f3a/codex-rs/app-server-protocol/src/protocol/v2/account.rs#L340-L462
[O4]: https://github.com/openai/codex/blob/03b7e22f9448469f0834ca05a12a1a92ddc52f3a/codex-rs/codex-backend-openapi-models/src/models/rate_limit_window_snapshot.rs#L12-L22
[O5]: https://github.com/openai/codex/blob/03b7e22f9448469f0834ca05a12a1a92ddc52f3a/codex-rs/protocol/src/protocol.rs#L2622-L2632
[O6]: https://github.com/openai/codex/blob/03b7e22f9448469f0834ca05a12a1a92ddc52f3a/codex-rs/tui/src/slash_command.rs#L94-L126
[O7]: https://github.com/openai/codex/blob/03b7e22f9448469f0834ca05a12a1a92ddc52f3a/codex-rs/model-provider/src/bearer_auth_provider.rs#L34-L49
[O8]: https://github.com/openai/codex/blob/03b7e22f9448469f0834ca05a12a1a92ddc52f3a/codex-rs/backend-client/src/client/rate_limit_resets_tests.rs#L92-L170
[O9]: https://github.com/openai/codex/blob/03b7e22f9448469f0834ca05a12a1a92ddc52f3a/codex-rs/app-server-protocol/src/protocol/common.rs#L1393-L1403
[O10]: https://github.com/openai/codex/blob/03b7e22f9448469f0834ca05a12a1a92ddc52f3a/codex-rs/app-server/src/request_processors/account_processor/rate_limit_resets.rs#L3-L119

- [OpenAI backend window conversion](https://github.com/openai/codex/blob/03b7e22f9448469f0834ca05a12a1a92ddc52f3a/codex-rs/backend-client/src/client.rs#L770-L784): `reset_at` to protocol `resets_at`.
- [OpenAI OAuth refresh response/endpoint resolution](https://github.com/openai/codex/blob/03b7e22f9448469f0834ca05a12a1a92ddc52f3a/codex-rs/login/src/auth/manager.rs#L1786-L1809): tokens/issuer are authentication state, separate from quota-reset endpoints.

### Audited extension source (permanent)

[P1]: https://github.com/narumiruna/pi-extensions/blob/8521e139d26ac96dcce1470aeaf6bb305ccdd656/packages/pi-usage/src/query.ts#L60-L125
[P2]: https://github.com/narumiruna/pi-extensions/blob/8521e139d26ac96dcce1470aeaf6bb305ccdd656/packages/pi-usage/src/providers/codex.ts#L4-L112
[P3]: https://github.com/narumiruna/pi-extensions/blob/8521e139d26ac96dcce1470aeaf6bb305ccdd656/packages/pi-usage/src/codex-resets.ts#L8-L301
[P4]: https://github.com/narumiruna/pi-extensions/blob/8521e139d26ac96dcce1470aeaf6bb305ccdd656/packages/pi-usage/src/query.ts#L404-L600
[P5]: https://github.com/narumiruna/pi-extensions/blob/8521e139d26ac96dcce1470aeaf6bb305ccdd656/packages/pi-usage/src/usage.ts#L1460-L1615
[P6]: https://github.com/narumiruna/pi-extensions/blob/8521e139d26ac96dcce1470aeaf6bb305ccdd656/packages/pi-usage/src/oauth-credential-source.ts#L1-L115
[P7]: https://github.com/narumiruna/pi-extensions/blob/8521e139d26ac96dcce1470aeaf6bb305ccdd656/packages/pi-usage/src/query.ts#L686-L766

- [Extension operations guide](https://github.com/narumiruna/pi-extensions/blob/8521e139d26ac96dcce1470aeaf6bb305ccdd656/packages/pi-usage/docs/operations.md#L44-L52): user-facing redemption flow; owning protocol verified separately above.

### Official live documentation (mutable; retrieved 2026-10-29)

[D1]: https://developers.openai.com/codex/pricing
[D2]: https://developers.openai.com/codex/auth

- D1: sections “Frequently asked questions / What are the usage limits for my plan?” and “Invite friends and coworkers.” These are live policy documents, not commit-pinned contracts.
- D2: sections “Login caching” and “Credential storage.” Storage/refresh facts were checked against official documentation, without opening any user's actual auth files.

Reference labels above resolve to the pinned or official URLs. Local repository and installed-Pi observations are explicitly identified as local observations rather than attributed to a remote commit that was not verified.
