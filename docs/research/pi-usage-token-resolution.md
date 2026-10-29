# Where pi-usage gets the ChatGPT/Codex token

## Scope, pins, and safety

Audited **2026-10-29 UTC**, public source fetched around 18:00 UTC. This is an independent authentication trace, complementing (not replacing) [`pi-usage-codex-resets.md`](pi-usage-codex-resets.md). No credentials were opened, no authenticated requests/login/refresh/redemption were made, and no implementation was changed.

Source identities:

- **E** — `narumiruna/pi-extensions` **`8521e139d26ac96dcce1470aeaf6bb305ccdd656`**; `packages/pi-usage/package.json` says **0.68.4**, host peer ranges `*`, development dependencies Pi **1.4.0**.[E0]
- **P** — owning upstream is now **`earendil-works/pi`**, packages **`@earendil-works/pi-coding-agent`** and **`@earendil-works/pi-ai`**, not an assumption about an older `@mariozechner` release. Audited main commit **`e7a0df27c09d11bf4161d3605246cbf57a129cb2`**, package version **1.4.0**.[P0]
- Installed local documentation/package snapshot: **`@earendil-works/pi-coding-agent` 1.3.0**, under `/nix/store/6p54359amf2yif1bf9wzgxg134kvvily-pi-coding-agent-1.3.0/lib/node_modules/pi-monorepo`. Read the complete applicable README, `extensions.md`, `custom-provider.md`, `configuration.md`, `settings.md`, and relevant linked `providers.md`, `models.md`, `sdk.md`, `security.md`, `packages.md`, `environment-variables.md`, plus the SDK credential example. These are installed documentation observations, not proof of the installed bundle's Git identity.
- Upstream **v1.3.0** resolves to **`71023aec1546d6d677a65669c5665c0927ce0dd0`**. Compared it with P: `auth/resolve.ts`, Codex OAuth provider, `auth-storage.ts`, `runtime-credentials.ts`, and `model-registry.ts` are unchanged; the inspected `Models.getAuth`/login and provider-composer auth logic also do not change in that diff. Main has other model/telemetry changes. Do not generalize this to compatibility with all past Pi versions or prove Nix bundle equivalence from its version string.
- **C** — OpenAI-owned source **`openai/codex` `03b7e22f9448469f0834ca05a12a1a92ddc52f3a`**, used only to distinguish Codex's own store.[C1][C2][C3]

Repository conventions: inspected the supplied agent instructions (prefer pnpm), research skill, existing note, root layout, root `package.json` (private pnpm 10 TypeScript workspace), and Git status. No repository `AGENTS.md` was found. This repository already uses `docs/research`; unrelated staged changes and the previous note were left untouched. This run is already the requested research sub-agent, rather than spawning a redundant research task.

## Bottom line

**pi-usage normally gets an already resolved access token from the running Pi model registry.** With ordinary Pi `/login openai-codex`, the underlying credential is Pi's **`<agent-dir>/auth.json["openai-codex"]`**, normally `~/.pi/agent/auth.json`. Pi AI owns the OAuth exchange/refresh protocol; Pi's credential store owns persistence and locking. The field named **`apiKey` in resolved request auth is the OAuth access token** for this provider, not an OpenAI platform API key.[E1][P1][P2][P3][P4]

**Reset redemption is stricter than passive legacy Codex usage.** It starts with the same runtime resolution, then requires a matching full OAuth candidate (access + refresh + account identity) from the extension credential-source channel and/or Pi's standalone stored-credential helper. It does not choose whichever token happens to be in a file.[E2][E3]

**Neither traced built-in path reads Codex CLI's `~/.codex/auth.json` or honors `CODEX_HOME`.** There is no automatic Codex CLI import here. A custom provider/SDK credential store/credential command/compatible extension could explicitly read or import external credentials, but that would be behavior of that configured component, not pi-usage's default implementation. Merely pointing Pi's auth path at Codex's file is not an adapter: their JSON schemas differ.[P4][P5][C1][C2]

## 1. Passive GET: precise resolution and transport chain

### Legacy provider `openai-codex`

The UI/status refresh route is `queryCurrentState → queryAdapterState` (which resolves runtime auth and queries/caches reports) → `queryProviderUsage → openai-codex adapter.query → fetchProviderJson`. The extension creates `createOAuthCredentialCandidateReader(pi, credentialReader)` once and supplies it to normal usage resolution.[E4][E5]

`resolveUsageAuth(ctx, adapter)` performs these steps:[E1]

1. Reject a selected model of this provider with a nonofficial origin. Find a model candidate from current model, registry `getAvailable()`, then `getAll()`, deduplicated by provider/model ID. Codex's allowed origin is exactly `https://chatgpt.com` (origin check, not an exact path check).
2. Wait for the optional credential-readiness channel before resolving auth. This matters even though legacy Codex GET does not need full OAuth candidates: another extension may still be activating runtime keys/headers.
3. Inspect `ctx.modelRegistry.getProvider("openai-codex")`; reject nonofficial configured provider base URLs.
4. If the current model is a Codex model, call **`getApiKeyAndHeaders(currentModel)`**. Fail on its `{ok:false}` result. For Codex, retain the result only when `authorizationFrom(result)` is truthy.
5. Call **`getProviderAuth("openai-codex")`** regardless, validating the resolved provider base URL; reject resolved model proxy origins too. Missing `getProviderAuth` raises the extension's historical “Pi 0.81.0 or newer” message. That message is not a sufficient compatibility guarantee for the current package.
6. Select `modelAuth ?? providerResult.auth`. Thus selected-model headers can win; when inspecting another provider's usage there is no selected-model auth call and provider auth is used.
7. In the generic Codex branch, derive `Authorization = case-insensitive Authorization header ?? (apiKey ? "Bearer " + apiKey : undefined)`. Construct a **new request-header object containing only Authorization**; other runtime headers, including an account header, are not copied into this legacy request. Preserve provider auth/source/base URL separately for fingerprinting/redaction.
8. Adapter sends **GET `https://chatgpt.com/backend-api/wham/usage`**. The shared fetch helper adds `User-Agent: pi-usage` and sends those normalized headers.[E5][E6]

Important boundaries:

- Legacy GET **does not call `readStoredCredential` to obtain its bearer**, does not match OAuth candidates, does not decode the JWT, and does not require `providerResult.source === "OAuth"`. Its injected reader exists in the common function signature but the Codex generic branch does not use it.[E1]
- Selected-model resolution and provider resolution are separate awaited calls; in Codex's branch selected-model auth is read **first**. Source does not make them an atomic identity snapshot. Do not promise atomicity across a concurrent account change.
- A case-insensitive explicit Authorization header takes precedence over `apiKey` via `??`. Empty/header-removal edge cases in this legacy path are not equivalent to the stricter companion path below. Treat this as a description, not a recommended security policy.[E1][E7]
- “Passive” means no **quota redemption**; resolving auth can still refresh OAuth and write the credential store before the usage GET.
- Origin checks reject known custom/proxy routing before forwarding a credential to the official usage endpoint. They cannot prove a credential's issuer/entitlement. An HTTP transport proxy (`HTTP_PROXY`/`HTTPS_PROXY`) is distinct from a custom provider base URL.

### Native `openai` is a separate provider

Current sources also have native ChatGPT usage under provider **`openai`**, not simply an alias for `openai-codex`. Its common resolver requires `source === "OAuth"` and full candidates for native ChatGPT auth. The optional **`openaiUseCodexUsage`** setting defaults **false**. When enabled, `resolveOpenAICompanionAuth` separately resolves **`openai-codex`** via Pi, requires its source to be OAuth, validates runtime Authorization and a unique matching candidate/account claim, then stores companion headers `Authorization` and `ChatGPT-Account-Id`. It does **not** turn a native OpenAI API key/token into a Codex token, load Codex CLI credentials, or prove the native and companion accounts are the same. Its source comment explicitly says app registration metadata is not cryptographic same-account proof. This read-only companion mechanism is deliberately separate from reset policy.[E1][E8][E9]

## 2. Mutation: additional authentication gates

Reset-credit listing and consumption use **`resolveCodexResetAuth`**, not the permissive legacy GET headers alone.[E2]

1. Require the **current model provider exactly `openai-codex`**; save provider/model identity.
2. Wait for credential sources to be ready.
3. Call `resolveUsageAuth` for Codex (without passing a candidate reader to that inner call); confirm the current model identity did not change. This resolves/possibly refreshes Pi runtime auth as above.
4. **After runtime resolution**, collect full OAuth candidates. This ordering permits the stored fallback to observe credentials that Pi has just refreshed.
5. Extract bearer from normalized Authorization (or `auth.apiKey` fallback). Decode the JWT payload's `https://api.openai.com/auth.chatgpt_account_id`. Require a nonempty, printable-ASCII header-safe account ID of at most 512 characters.
6. Examine candidates with `type:"oauth"`. Only **exact `candidate.access === resolvedAccess`** matches qualify. Require nonempty refresh token and valid `candidate.accountId` equal to the JWT account claim. A matching candidate with invalid/mismatched identity causes failure even if another candidate looks valid. Matches are keyed by refresh token: identical duplicates collapse, **different refresh tokens for the same access token are conflicting** and rejected.
7. Emit **only** `Authorization: Bearer <resolvedAccess>` plus **`chatgpt-account-id: <matched accountId>`**, with a salted auth fingerprint. The refresh token is used as local credential evidence, **never sent to usage/reset endpoints**.

Candidate collection validates finite `expires`, but the reset selector does not independently demand a future expiry; freshness is delegated to runtime resolution and the credential owner. JWT payload decoding is **not signature verification** and does not authorize a user locally; the service validates the bearer. The account claim is an identity-consistency guard, not a replacement for that validation.[E2][E3]

`usage.ts` resolves this auth for GET `/wham/rate-limit-reset-credits`, re-resolves after loading the menu, and compares model identity/fingerprint. On explicit confirmation, it resolves again and compares against the confirmed identity before POST `/wham/rate-limit-reset-credits/consume`. The JSON body is `{redeem_request_id, credit_id?}`. It retains one UUID for retry of that logical attempt and refetches usage after consumption. A token rotation can change the fingerprint even for the same account, safely forcing a fresh confirmation rather than reusing an obsolete bearer. Authentication refresh is not quota reset.[E10]

## 3. Full OAuth candidates: channel and stored fallback

These channels are **an extension-to-extension convention**, not a magical Pi credential database or a network service:[E3]

- **`oauth:credential-readiness:v1`**: emit frozen `{session: ctx.sessionManager, provider, waitUntil}`. Synchronous listeners may register Promise instances while dispatch is open; await them all. Emit/rejection failures fail closed.
- **`oauth:credential-source:v1`**: emit frozen `{session, provider, offer}`. Synchronous offers during dispatch only; later asynchronous offers are ignored. Structured-clone offered objects; accept only OAuth objects with nonempty access/refresh and finite numeric expires. Account ID is checked later by the consumer.
- Then **always append the standalone stored OAuth fallback**, not only when nobody offered anything. `offeredCount` counts accepted channel offers before the fallback; it mainly informs diagnostics. If channel dispatch throws, discovery fails; malformed/unavailable fallback is simply absent.
- The default fallback is **`readStoredCredential(providerId)`**, exported by `@earendil-works/pi-coding-agent`. It reads/JSON-parses `<getAgentDir()>/auth.json`, selects the provider entry, strips BOM, catches errors and returns undefined. It is a one-off **synchronous read**, no refresh, lock, configured-key execution, or runtime override resolution.[P4]

### Concrete compatible source: `pi-accounts`

In this same repository, **`pi-accounts`** registers both channels. Its session-owner lookup and coordinator offer only the OAuth credential successfully applied to the **same session and provider**; activation must complete before publishing an offer. It clones the credential, rather than exposing its mutable internal store.[A1][A2]

Its own default file is **`<getAgentDir()>/pi-accounts.json`** (normally `~/.pi/agent/pi-accounts.json`), shaped as `version:1 → providers[providerId] → accounts[name]`; `active` is a default for sessions without a saved choice. Session selection and optional **`PI_ACCOUNT`** choose a saved account; these are not auth-file path overrides. It can migrate **Pi agent-directory** legacy files `pi-codex-accounts.json` / `codex-accounts.json`. Those names are **not Codex CLI's `~/.codex/auth.json`**.[A3][A4]

For Codex, `pi-accounts` imports the host's **`@earendil-works/pi-ai/providers/all`**, finds the built-in provider's `auth.oauth`, and delegates `login`, `refresh`, `toAuth` to it. Its coordinator owns named-account persistence/activation: within five minutes of expiry, re-read and recheck inside the account store's serialized locked update, call provider refresh, save the new full credential, derive request auth, install a provider API-key bridge plus runtime API-key override, verify effective auth, then publish the full OAuth offer.[A2][A5]

Consequently runtime auth can look **API-key-shaped/source `stored credential`** while really carrying a named OAuth account's **access token**. Reset does not reject this merely because the runtime source label is not OAuth: it validates the full candidate instead. Conversely the companion path explicitly requires source OAuth and may reject such a runtime bridge; do not assume every compatible reset credential source also satisfies companion policy.[E2][E8][A2]

The account store uses an in-process queue plus `proper-lockfile`, rechecks expiry under lock, and writes a private temporary file then renames it. **Its cancellation semantics differ from Pi AI's core refresh helper**: the inspected coordinator passes an activation/owner signal to provider refresh and checks cancellation afterward; the storage layer checks cancellation before writing. Do not claim the core's cancellation-shielded refresh guarantee automatically applies to named accounts. A rotation followed by cancellation before persistence remains a design risk to evaluate, not something proven safe by the channel.[A2][A6]

## 4. Owning Pi runtime, login, refresh, persistence

### API-to-store chain

```text
pi-usage.resolveUsageAuth
  → ctx.modelRegistry.getApiKeyAndHeaders(current model)
      → ModelRuntime.getAuth(model)
          → pi-ai Models.getAuth(model)
              → resolveProviderAuth(composed provider, RuntimeCredentials, ...)
          → merge configured model headers
      → {ok:true, apiKey, headers, baseUrl?, env?} / {ok:false,error}
  → ctx.modelRegistry.getProviderAuth(provider ID)
      → ModelRuntime.getAuth(provider ID)
          → pi-ai Models.getAuth(provider ID)
              → resolveProviderAuth(...)
      → {auth, source, env?} or undefined
```

`ModelRegistry` is a compatibility facade over `ModelRuntime`; it does not itself load Codex CLI tokens. Provider-level resolution does not apply selected-model headers; model-level resolution merges them. Provider composition supports built-in/native providers, `models.json`, and extension registration, including custom auth/base URLs/headers.[P1][P2][P6][P7]

`ModelRuntime` wraps its configured credential store with **`RuntimeCredentials`**. A nonempty `setRuntimeApiKey(provider, value)` overrides reads with `{type:"api_key", key:value}` in memory. Otherwise reads reach the configured store. `Models.getAuth` resolves the composed provider's auth method, then merges model headers. Stored OAuth owns the provider: a failed refresh or unsupported stored credential type does **not** silently fall through to an environment API key.[P2][P3][P5]

For ordinary Pi configuration the documented order is runtime key, stored credential, configured provider `apiKey`, then environment/ambient auth. For actual stored API-key credentials, `AuthStorage.read` resolves the `key` configuration value (including command/environment syntax); `readStoredCredential` deliberately does not. Provider/model configuration can likewise resolve literal, `$NAME`/`${NAME}`, or `!command` values and configured headers. These are extensible credential acquisition mechanisms, not evidence of an automatic Codex CLI import. [AuthStorage read](https://github.com/earendil-works/pi/blob/e7a0df27c09d11bf4161d3605246cbf57a129cb2/packages/coding-agent/src/core/auth-storage.ts#L442-L448) and provider composition own that behavior.[P7]

But **built-in `openai-codex` is OAuth-only**, with base URL `https://chatgpt.com/backend-api`; it does not declare an `OPENAI_API_KEY` or `CODEX_API_KEY` fallback. Provider composition deliberately avoids fabricating an API-key method for an OAuth-only provider unless a configured key/bridge adds one. `openai` platform API credentials, dummy proxy keys and arbitrary `--api-key` values are not subscription entitlement.[P6][P7]

### Initial login

Pi interactive `/login` ultimately calls `ModelRuntime.login → Models.login → provider.auth.oauth.login`, then stores the returned credential through `credentials.modify(providerId, ...)`. The OAuth provider owns protocol; the store owns persistence.[P8]

The Codex provider offers browser and headless device-code methods:[P9]

- Browser: PKCE/S256 + state, authorization at `https://auth.openai.com/oauth/authorize`, client ID `app_EMoamEEZ73f0CkXaXp7hrann`, scope `openid profile email offline_access`, redirect `http://localhost:1455/auth/callback`; default bind host `127.0.0.1`, override **`PI_OAUTH_CALLBACK_HOST`**. If port 1455 is busy (possibly Codex CLI), use pasted redirect/code; **shared port is not shared credentials**.
- Device: request/poll `https://auth.openai.com/api/accounts/deviceauth/{usercode,token}`, user visits `https://auth.openai.com/codex/device`, then exchange the returned authorization code/verifier using the device redirect URI.
- Both exchange at **`https://auth.openai.com/oauth/token`**, normalize `access_token → access`, `refresh_token → refresh`, `expires_in → Date.now() + seconds*1000`, extract `accountId` from the access token claim, and return the full OAuth credential. An ID token is not required or retained by this provider's normalization.

### Automatic refresh

On auth resolution, Pi AI checks **`Date.now() + 5 minutes >= expires`** (explicit minimum-validity callers may demand more). If necessary:[P3]

1. Enter `CredentialStore.modify` and re-read the current credential **under lock**.
2. If logged out or another caller already refreshed, do not exchange the stale token.
3. Invoke provider `oauth.refresh(current, AbortSignal.timeout(15000))`.
4. Codex refresh POSTs form-encoded `grant_type=refresh_token`, `refresh_token`, and `client_id` to the same token endpoint. Require a returned access token, refresh token, and numeric expiry; rederive account ID from the new access token.[P9]
5. Persist the replacement before releasing the lock. `toAuth` then returns **`{apiKey: credential.access}`**. Refresh token remains in credential storage, not request auth.

The core helper cancels waiting for the lock when its caller cancels, but once refresh starts it shields refresh/persistence from that caller signal and uses its own timeout, to avoid discarding a rotated refresh token. This is request-time resolution, **not a background timer in pi-usage** and not a guarantee that arbitrary custom stores correctly serialize writes.[P3]

Default `AuthStorage` implements async read/modify/list/delete over a file backend. `modify` merges only the provider entry into freshly parsed current data. The backend holds `proper-lockfile` around read/network mutation/write, uses a 30-second stale-lock/wait policy and retry logic, writes JSON with mode `0600`, and creates missing parent directories with `0700`. Its write is `writeFileSync` under lock, **not an atomic rename**. These locks coordinate cooperating users of the same backend/path, not arbitrary external editors or Codex's independent store. In-memory/custom/read-only stores have different guarantees; the read-only store cannot persist a needed refresh.[P4]

## 5. Paths, overrides, and synthetic JSON

Default `getAgentDir()` is `join(homedir(), ".pi", "agent")`; **`PI_CODING_AGENT_DIR`** overrides it (tilde expansion). SDK `createAgentSession({agentDir})` derives its default runtime auth/model paths from that directory. More directly, `ModelRuntime.create({authPath, modelsPath, credentials})` can set a file path or replace storage entirely; explicit `credentials` wins over constructing the default `AuthStorage`. Model configuration normally lives in `<agent-dir>/models.json`, not project `.pi/auth.json`.[P5][P10]

**Subtle override mismatch:** pi-usage's default `readStoredCredential(provider)` fallback uses **global `getAgentDir()`**, not the runtime's custom `authPath`, SDK-local `agentDir`, or custom credential store. Therefore a custom runtime may successfully GET usage yet fail reset matching unless a compatible candidate source or an injected `credentialReader` supplies the runtime's full OAuth credential. The helper itself accepts an explicit second `authPath`, but pi-usage's default call does not supply one.[E3][P4][P10]

Synthetic Pi `auth.json` only (placeholder strings are not usable tokens):

```json
{
  "openai-codex": {
    "type": "oauth",
    "access": "<ChatGPT OAuth access JWT>",
    "refresh": "<OAuth refresh token>",
    "expires": 1900000000000,
    "accountId": "synthetic-account-id"
  },
  "openai": {
    "type": "api_key",
    "key": "<actual platform API key, unrelated to Codex subscription>"
  }
}
```

`expires` is epoch **milliseconds**, unlike usage-reset timestamps in epoch seconds. The access JWT payload used for matching is conceptually `{"https://api.openai.com/auth":{"chatgpt_account_id":"synthetic-account-id"}}`; do not log a real JWT to inspect it. Provider-specific extra fields can exist. This is not a full auth-file validator specification.[P9][E2]

Synthetic named-account structure (credential fields abbreviated for readability):

```json
{
  "version": 1,
  "providers": {
    "openai-codex": {
      "active": "work",
      "accounts": {
        "work": {
          "type": "oauth",
          "access": "<access JWT>",
          "refresh": "<refresh token>",
          "expires": 1900000000000,
          "accountId": "synthetic-account-id"
        }
      }
    }
  }
}
```

Codex CLI instead owns **`$CODEX_HOME/auth.json`**, default `~/.codex/auth.json`, with top-level `auth_mode`, `OPENAI_API_KEY`, `tokens`, `last_refresh`, etc.; `tokens` includes `id_token`, `access_token`, `refresh_token`, optional `account_id` and provenance/login-owner fields. Codex can use file, keyring, auto, or ephemeral storage, so absence of that file is not absence of login. Pi's provider-indexed `access/refresh/expires/accountId` format is not this shape.[C1][C2][C3]

**Exact cases:** default Pi login → Pi auth file; named pi-accounts account → pi-accounts file through runtime bridge + candidate channel; custom SDK/runtime → its configured store, with the fallback caveat above; arbitrary third-party provider/credential command → whatever that component explicitly implements. None of the traced default components discovers, refreshes, or persists Codex CLI's auth file.

## 6. Minimal source-derived pseudocode

```typescript
// Simplified legacy GET; not a standalone credential importer.
await waitForCredentialReadiness(session, "openai-codex");
assertOfficialModelAndProviderOrigins();
const modelAuth = currentIsCodex ? await registry.getApiKeyAndHeaders(model) : undefined;
const provider = await registry.getProviderAuth("openai-codex"); // may refresh/persist
assertOfficialResolvedOrigins(modelAuth, provider);
const auth = usableSelectedAuth(modelAuth) ?? provider?.auth;
const authorization = headerCI(auth, "Authorization") ?? bearer(auth?.apiKey);
GET(officialUsageURL, { Authorization: authorization });

// Reset: full credential evidence in addition to that runtime bearer.
assertCurrentProvider("openai-codex");
await waitForCredentialReadiness(session, "openai-codex");
const runtime = await resolveUsageAuth();
const candidates = [...synchronousChannelOffers(session, providerId), storedPiOAuthFallback()];
const access = extractResolvedBearer(runtime);
const claimAccount = decodeAccountClaim(access); // NOT JWT signature verification
const match = requireUniqueValidOAuthMatch(candidates, access, claimAccount);
const resetAuth = { Authorization: `Bearer ${access}`, "chatgpt-account-id": match.accountId };
// Re-resolve/check identity against confirmed attempt immediately before mutation.
POST(officialConsumeURL, resetAuth, { redeem_request_id: stableAttemptId, credit_id: chosenCredit });
```

This omits lifecycle guards, caches, error redaction and UI for clarity. In particular **do not implement the first awaited provider call as a raw JSON read**: that would omit refresh and runtime/provider overlays.[E1][E2][P3]

## 7. Guidance for standalone CodexAutoReset

1. **Choose one authentication owner explicitly.** If the intended account belongs to Codex CLI, prefer a version-checked first-party Codex app-server integration (see the prior note); keep login, refresh and persistence inside Codex. This research does not prove the user's installed binary exposes current-main account/reset methods.
2. If intentionally using Pi login, resolve through a pinned compatible Pi runtime/credential store, not “read `access` and hope.” Avoid loading arbitrary user/project extensions just to get a token in a daemon. A focused adapter should return account-bound request auth and an identity generation, keeping secrets out of domain models and logs.
3. If importing another store is an explicit product feature, implement its schema/storage modes and refresh concurrency deliberately; never silently fall back from Pi to Codex, or vice versa. Do not independently rotate a refresh token shared with an uncoordinated CLI. Pi locks do not establish ownership of Codex's store/keyring.
4. An `apiKey` property or source label is **not a token-kind test**. Require the provider/account contract; actual OpenAI API keys cannot be assumed to authorize subscription usage or reset redemption. Honor configured routing for model calls, but never forward unknown proxy/custom-provider credentials to ChatGPT as a usage probe.
5. Bind mutation confirmation, selected credit and durable retry UUID to the authenticated account. Re-resolve before POST and after account changes. Keep read-only polling separate from redemption; authentication renewal itself never replenishes quota.
6. Use `redirect:"error"` for a new official-endpoint client. The extension's helper checks `response.redirected` **after** fetch and does not set a redirect policy for these Codex calls; this is not a preflight redirect prohibition.[E6]
7. Test with synthetic stores and fake providers: imminent expiry, concurrent refresh, logout/login during refresh, cancellation after rotation, custom runtime path versus default fallback, named-account activation races, exact access mismatch, conflicting refresh candidates, invalid account claim, explicit Authorization override/removal, proxy origin, and successful mutation followed by failed refresh. Never run real reset POSTs as routine integration tests.

### Limits and version drift

The trace establishes public client behavior, not backend entitlement or deployment availability. Custom provider code can replace essentially every auth assumption. Installed docs are 1.3.0 whereas the extension's development target and audited upstream main are 1.4.0; old Pi examples using different package names/API shapes need a separate trace. JWT decoding is local metadata extraction, not verified issuer identity. No claim is made that every credential source is cancellation-safe or that independent credential owners share locks. No production credentials or endpoints were exercised.

## Pinned primary-source references

### Extension E

[E0]: https://github.com/narumiruna/pi-extensions/blob/8521e139d26ac96dcce1470aeaf6bb305ccdd656/packages/pi-usage/package.json#L1-L65
[E1]: https://github.com/narumiruna/pi-extensions/blob/8521e139d26ac96dcce1470aeaf6bb305ccdd656/packages/pi-usage/src/query.ts#L406-L576
[E2]: https://github.com/narumiruna/pi-extensions/blob/8521e139d26ac96dcce1470aeaf6bb305ccdd656/packages/pi-usage/src/codex-resets.ts#L94-L301
[E3]: https://github.com/narumiruna/pi-extensions/blob/8521e139d26ac96dcce1470aeaf6bb305ccdd656/packages/pi-usage/src/oauth-credential-source.ts#L1-L115
[E4]: https://github.com/narumiruna/pi-extensions/blob/8521e139d26ac96dcce1470aeaf6bb305ccdd656/packages/pi-usage/src/usage.ts#L101-L150
[E5]: https://github.com/narumiruna/pi-extensions/blob/8521e139d26ac96dcce1470aeaf6bb305ccdd656/packages/pi-usage/src/query.ts#L60-L127
[E6]: https://github.com/narumiruna/pi-extensions/blob/8521e139d26ac96dcce1470aeaf6bb305ccdd656/packages/pi-usage/src/query.ts#L686-L766
[E7]: https://github.com/narumiruna/pi-extensions/blob/8521e139d26ac96dcce1470aeaf6bb305ccdd656/packages/pi-usage/src/query.ts#L975-L1010
[E8]: https://github.com/narumiruna/pi-extensions/blob/8521e139d26ac96dcce1470aeaf6bb305ccdd656/packages/pi-usage/src/openai-companion-auth.ts#L1-L118
[E9]: https://github.com/narumiruna/pi-extensions/blob/8521e139d26ac96dcce1470aeaf6bb305ccdd656/packages/pi-usage/src/settings.ts#L16-L32
[E10]: https://github.com/narumiruna/pi-extensions/blob/8521e139d26ac96dcce1470aeaf6bb305ccdd656/packages/pi-usage/src/usage.ts#L1474-L1615

- [Query execution](https://github.com/narumiruna/pi-extensions/blob/8521e139d26ac96dcce1470aeaf6bb305ccdd656/packages/pi-usage/src/usage.ts#L560-L600), [current-provider query](https://github.com/narumiruna/pi-extensions/blob/8521e139d26ac96dcce1470aeaf6bb305ccdd656/packages/pi-usage/src/usage.ts#L799-L831), [candidate models](https://github.com/narumiruna/pi-extensions/blob/8521e139d26ac96dcce1470aeaf6bb305ccdd656/packages/pi-usage/src/query.ts#L670-L684).

### Compatible source pi-accounts, also E

[A1]: https://github.com/narumiruna/pi-extensions/blob/8521e139d26ac96dcce1470aeaf6bb305ccdd656/packages/pi-accounts/src/oauth-credential-source.ts#L1-L65
[A2]: https://github.com/narumiruna/pi-extensions/blob/8521e139d26ac96dcce1470aeaf6bb305ccdd656/packages/pi-accounts/src/runtime-auth.ts#L135-L401
[A3]: https://github.com/narumiruna/pi-extensions/blob/8521e139d26ac96dcce1470aeaf6bb305ccdd656/packages/pi-accounts/src/account-store.ts#L18-L108
[A4]: https://github.com/narumiruna/pi-extensions/blob/8521e139d26ac96dcce1470aeaf6bb305ccdd656/packages/pi-accounts/src/account-store.ts#L360-L399
[A5]: https://github.com/narumiruna/pi-extensions/blob/8521e139d26ac96dcce1470aeaf6bb305ccdd656/packages/pi-accounts/src/oauth.ts#L355-L394
[A6]: https://github.com/narumiruna/pi-extensions/blob/8521e139d26ac96dcce1470aeaf6bb305ccdd656/packages/pi-accounts/src/storage.ts#L152-L260

- [Session-scoped source registration](https://github.com/narumiruna/pi-extensions/blob/8521e139d26ac96dcce1470aeaf6bb305ccdd656/packages/pi-accounts/src/accounts.ts#L111-L132), [readiness](https://github.com/narumiruna/pi-extensions/blob/8521e139d26ac96dcce1470aeaf6bb305ccdd656/packages/pi-accounts/src/accounts.ts#L434-L450), [`PI_ACCOUNT`](https://github.com/narumiruna/pi-extensions/blob/8521e139d26ac96dcce1470aeaf6bb305ccdd656/packages/pi-accounts/src/accounts.ts#L926-L941).
- [Codex adapter](https://github.com/narumiruna/pi-extensions/blob/8521e139d26ac96dcce1470aeaf6bb305ccdd656/packages/pi-accounts/src/oauth.ts#L82-L91), [API-key bridge and runtime override controller](https://github.com/narumiruna/pi-extensions/blob/8521e139d26ac96dcce1470aeaf6bb305ccdd656/packages/pi-accounts/src/runtime-auth.ts#L627-L789).

### Owning Pi source P

[P0]: https://github.com/earendil-works/pi/blob/e7a0df27c09d11bf4161d3605246cbf57a129cb2/packages/coding-agent/package.json#L1-L5
[P1]: https://github.com/earendil-works/pi/blob/e7a0df27c09d11bf4161d3605246cbf57a129cb2/packages/coding-agent/src/core/model-registry.ts#L89-L118
[P2]: https://github.com/earendil-works/pi/blob/e7a0df27c09d11bf4161d3605246cbf57a129cb2/packages/ai/src/models.ts#L754-L829
[P3]: https://github.com/earendil-works/pi/blob/e7a0df27c09d11bf4161d3605246cbf57a129cb2/packages/ai/src/auth/resolve.ts#L27-L191
[P4]: https://github.com/earendil-works/pi/blob/e7a0df27c09d11bf4161d3605246cbf57a129cb2/packages/coding-agent/src/core/auth-storage.ts#L61-L201
[P5]: https://github.com/earendil-works/pi/blob/e7a0df27c09d11bf4161d3605246cbf57a129cb2/packages/coding-agent/src/core/runtime-credentials.ts#L1-L53
[P6]: https://github.com/earendil-works/pi/blob/e7a0df27c09d11bf4161d3605246cbf57a129cb2/packages/ai/src/providers/openai-codex.ts#L1-L22
[P7]: https://github.com/earendil-works/pi/blob/e7a0df27c09d11bf4161d3605246cbf57a129cb2/packages/coding-agent/src/core/provider-composer.ts#L358-L517
[P8]: https://github.com/earendil-works/pi/blob/e7a0df27c09d11bf4161d3605246cbf57a129cb2/packages/coding-agent/src/core/model-runtime.ts#L834-L852
[P9]: https://github.com/earendil-works/pi/blob/e7a0df27c09d11bf4161d3605246cbf57a129cb2/packages/ai/src/auth/oauth/openai-codex.ts#L22-L439
[P10]: https://github.com/earendil-works/pi/blob/e7a0df27c09d11bf4161d3605246cbf57a129cb2/packages/coding-agent/src/core/sdk.ts#L193-L204

- [ModelRuntime storage construction](https://github.com/earendil-works/pi/blob/e7a0df27c09d11bf4161d3605246cbf57a129cb2/packages/coding-agent/src/core/model-runtime.ts#L108-L116), [construction implementation](https://github.com/earendil-works/pi/blob/e7a0df27c09d11bf4161d3605246cbf57a129cb2/packages/coding-agent/src/core/model-runtime.ts#L217-L245), [model/provider getAuth](https://github.com/earendil-works/pi/blob/e7a0df27c09d11bf4161d3605246cbf57a129cb2/packages/coding-agent/src/core/model-runtime.ts#L556-L579).
- [Provider-auth facade](https://github.com/earendil-works/pi/blob/e7a0df27c09d11bf4161d3605246cbf57a129cb2/packages/coding-agent/src/core/model-registry.ts#L194-L200).
- [AuthStorage modify and standalone reader](https://github.com/earendil-works/pi/blob/e7a0df27c09d11bf4161d3605246cbf57a129cb2/packages/coding-agent/src/core/auth-storage.ts#L450-L507), [default path](https://github.com/earendil-works/pi/blob/e7a0df27c09d11bf4161d3605246cbf57a129cb2/packages/coding-agent/src/config.ts#L604-L626).
- [Core credential-store contract](https://github.com/earendil-works/pi/blob/e7a0df27c09d11bf4161d3605246cbf57a129cb2/packages/ai/src/auth/types.ts#L20-L95).
- [Interactive login call](https://github.com/earendil-works/pi/blob/e7a0df27c09d11bf4161d3605246cbf57a129cb2/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L6420-L6445).
- [Version-pinned 1.3.0 refresh source](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/ai/src/auth/resolve.ts#L100-L191).

### Codex's separate store C

[C1]: https://github.com/openai/codex/blob/03b7e22f9448469f0834ca05a12a1a92ddc52f3a/codex-rs/login/src/auth/storage.rs#L47-L70
[C2]: https://github.com/openai/codex/blob/03b7e22f9448469f0834ca05a12a1a92ddc52f3a/codex-rs/login/src/token_data.rs#L10-L35
[C3]: https://github.com/openai/codex/blob/03b7e22f9448469f0834ca05a12a1a92ddc52f3a/codex-rs/utils/home-dir/src/lib.rs#L6-L64

- [Codex file path](https://github.com/openai/codex/blob/03b7e22f9448469f0834ca05a12a1a92ddc52f3a/codex-rs/login/src/auth/storage.rs#L161-L164), [storage-mode selection](https://github.com/openai/codex/blob/03b7e22f9448469f0834ca05a12a1a92ddc52f3a/codex-rs/login/src/auth/storage.rs#L653-L675).
