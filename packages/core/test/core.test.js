import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { AppError, HttpError, TokenExpiredError, CodexClient, readCredentials, resolveAuthFile } from '../dist/index.js';

const now = 1_800_000_000_000;
const jwt = (id = 'synthetic-account') => `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: id } })).toString('base64url')}.c2ln`;
const credentials = () => ({ access: jwt(), refresh: 'synthetic-refresh-secret', expires: now + 60_000, accountId: 'synthetic-account' });
const json = (value, init) => new Response(JSON.stringify(value), init);
const client = (fetch, options = {}) => new CodexClient(credentials(), { fetch, now: () => now, ...options });
const hasCode = code => error => error instanceof AppError && error.code === code;
const credit = overrides => ({ id: 'credit', reset_type: 'codex_rate_limits', status: 'available', expires_at: '2027-07-17T00:00:00Z', title: 'Full reset', description: null, ...overrides });

async function authFixture(run) {
  const dir = await mkdtemp(join(tmpdir(), 'codex-core-test-'));
  const path = join(dir, 'synthetic-auth.json');
  try { await run(path); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('auth path precedence and tilde expansion (does not read default paths)', () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  try {
    delete process.env.PI_CODING_AGENT_DIR;
    assert.equal(resolveAuthFile(), join(homedir(), '.pi/agent/auth.json'));
    process.env.PI_CODING_AGENT_DIR = '~/synthetic-agent';
    assert.equal(resolveAuthFile(), join(homedir(), 'synthetic-agent/auth.json'));
    assert.equal(resolveAuthFile('~/explicit.json'), join(homedir(), 'explicit.json'));
    assert.equal(resolveAuthFile('/explicit/auth.json'), '/explicit/auth.json');
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test('reads Pi OAuth without modifying file; expired credentials can be read', async () => {
  await authFixture(async path => {
    const c = { ...credentials(), expires: now - 1 };
    const content = '\uFEFF' + JSON.stringify({ 'openai-codex': { type: 'oauth', ...c } });
    await writeFile(path, content);
    assert.deepEqual(await readCredentials(path), c);
    assert.equal(await readFile(path, 'utf8'), content);
  });
});

test('rejects malformed auth, API keys, mismatched JWT, unsafe account ID and invalid OAuth fields', async () => {
  await authFixture(async path => {
    for (const entry of [null, { type: 'api_key', key: 'secret' },
      ...[{ access: 'secret' }, { refresh: '' }, { expires: 'future' }, { accountId: 'other' },
        { access: jwt('bad\naccount'), accountId: 'bad\naccount' }].map(patch => ({ type: 'oauth', ...credentials(), ...patch }))]) {
      await writeFile(path, JSON.stringify({ 'openai-codex': entry }));
      await assert.rejects(readCredentials(path), hasCode('invalid_credentials'));
    }
    await writeFile(path, 'malformed-secret');
    await assert.rejects(readCredentials(path), error => hasCode('credential_read_error')(error) && !String(error).includes('secret'));
    await assert.rejects(readCredentials(join(path, 'missing-secret')), error => !String(error).includes(path));
  });
});

test('all requests reject expired token without calling fetch', async () => {
  const c = new CodexClient({ ...credentials(), expires: now }, { now: () => now, fetch: () => assert.fail('must not fetch') });
  for (const request of [() => c.getUsage(), () => c.listResetCredits(), () => c.redeemReset('c', 'r')]) {
    await assert.rejects(request(), TokenExpiredError);
  }
});

test('usage normalizes only public fields; absent values remain unknown, seconds remain seconds', async () => {
  let call;
  const c = client(async (...args) => { call = args; return json({
    plan_type: 'plus', rate_limit: { primary_window: { used_percent: 37, reset_at: 1_800_007_200, limit_window_seconds: 18000, secret: 'hidden' }, secondary_window: {} },
    rate_limit_reset_credits: { available_count: 2 }, rawSecret: 'hidden',
  }); });
  assert.deepEqual(await c.getUsage(), { planType: 'plus', primary: { usedPercent: 37, resetAt: 1_800_007_200, durationSeconds: 18000 }, secondary: { usedPercent: null, resetAt: null, durationSeconds: null }, resetCreditsAvailable: 2 });
  assert.equal(call[0], 'https://chatgpt.com/backend-api/wham/usage');
  assert.equal(call[1].method, 'GET');
  assert.equal(call[1].redirect, 'error');
  assert.equal(call[1].headers.Authorization, `Bearer ${credentials().access}`);
  assert.equal(call[1].headers['chatgpt-account-id'], 'synthetic-account');
  assert.equal(call[1].body, undefined);
  assert.ok(!JSON.stringify(call).includes(credentials().refresh));
  assert.deepEqual(await client(async () => json({})).getUsage(), { planType: null, primary: null, secondary: null, resetCreditsAvailable: null });
});

test('malformed usage is rejected, not coerced into zero', async () => {
  for (const payload of [null, [], { rate_limit: [] }, { plan_type: 1 }, { rate_limit_reset_credits: {} },
    ...['37', -1, true, {}].map(used_percent => ({ rate_limit: { primary_window: { used_percent } } })),
    { rate_limit: { primary_window: { reset_at: 2.5 } } }]) {
    await assert.rejects(client(async () => json(payload)).getUsage(), hasCode('invalid_response'));
  }
});

test('lists credits, requires count/list/row fields and converts expiry to milliseconds', async () => {
  let url;
  const result = await client(async input => { url = input; return json({ available_count: 3, credits: [credit(), credit({ expires_at: null, title: null })] }); }).listResetCredits();
  assert.equal(url, 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits');
  assert.equal(result.availableCount, 3);
  assert.equal(result.credits[0].expiresAt, Date.parse('2027-07-17T00:00:00Z'));
  assert.equal(result.credits[1].expiresAt, null);
  assert.deepEqual(Object.keys(result.credits[0]).sort(), ['id', 'resetType', 'status', 'expiresAt', 'title', 'description'].sort());
  for (const payload of [{}, { credits: [] }, { available_count: 0 }, { available_count: '1', credits: [] }, { available_count: 0, credits: null },
    ...[{ id: '' }, { reset_type: null }, { status: 1 }, { expires_at: 1800000000 }, { expires_at: 'not-a-date' }, { expires_at: '2027-02-30T00:00:00Z' }, { expires_at: '2027-07-17T24:00:00Z' }, { title: {} }].map(overrides => ({ available_count: 1, credits: [credit(overrides)] }))]) {
    await assert.rejects(client(async () => json(payload)).listResetCredits(), hasCode('invalid_response'));
  }
});

test('redemption serializes exact stable identifiers and recognizes all outcomes', async () => {
  for (const code of ['reset', 'nothing_to_reset', 'no_credit', 'already_redeemed']) {
    const c = client(async (url, init) => {
      assert.equal(url, 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume');
      assert.equal(init.method, 'POST');
      assert.equal(init.headers['Content-Type'], 'application/json');
      assert.deepEqual(JSON.parse(init.body), { credit_id: 'opaque"credit', redeem_request_id: 'stable-request' });
      assert.equal(init.headers['Idempotency-Key'], undefined);
      return json({ code, windows_reset: 2, private_data: 'hidden' });
    });
    assert.deepEqual(await c.redeemReset('opaque"credit', 'stable-request'), { outcome: code, windowsReset: 2 });
  }
  assert.deepEqual(await client(async () => json({ code: 'no_credit' })).redeemReset('c', 'r'), { outcome: 'no_credit', windowsReset: 0 });
  await assert.rejects(client(async () => json({ code: 'surprise-secret' })).redeemReset('c', 'r'), error => hasCode('unknown_redemption_outcome')(error) && !String(error).includes('surprise'));
  for (const payload of [{}, { code: 1 }, { code: 'reset', windows_reset: null }, { code: 'reset', windows_reset: -1 }, { code: 'reset', windows_reset: 1.5 }]) {
    await assert.rejects(client(async () => json(payload)).redeemReset('c', 'r'), hasCode('invalid_response'));
  }
  await assert.rejects(client(() => assert.fail()).redeemReset('', 'r'), hasCode('invalid_request'));
});

test('HTTP errors expose only status and parsed retry-after, never body/headers', async () => {
  for (const [header, expected] of [['12', 12000], ['0.5', 500], [new Date(now + 30000).toUTCString(), 30000], [new Date(now - 10000).toUTCString(), 0], ['-1', null], ['garbage-secret', null], ['Infinity', null]]) {
    await assert.rejects(client(async () => new Response('body-secret', { status: 429, headers: { 'retry-after': header, 'x-secret': 'secret' } })).getUsage(), error => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 429);
      assert.equal(error.retryAfterMs, expected);
      assert.ok(!JSON.stringify(error).includes('secret'));
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});

test('redirects rejected and fetch errors sanitized, without automatic retries', async () => {
  await assert.rejects(client(async () => new Response('secret', { status: 302, headers: { location: 'https://evil.invalid' } })).getUsage(), hasCode('redirect_rejected'));
  await assert.rejects(client(async () => ({ redirected: true, status: 200 })).getUsage(), hasCode('redirect_rejected'));
  let calls = 0;
  await assert.rejects(client(async () => { calls++; throw new Error('token-secret'); }).redeemReset('c', 'r'), error => hasCode('transport_error')(error) && !String(error).includes('secret') && error.cause === undefined);
  assert.equal(calls, 1);
});

test('timeout covers both headers and body even if injected fetch ignores abort', async () => {
  let signal;
  await assert.rejects(client(async (_url, init) => { signal = init.signal; return new Promise(() => {}); }, { timeoutMs: 5 }).redeemReset('c', 'r'), hasCode('transport_error'));
  assert.equal(signal.aborted, true);
  await assert.rejects(client(async () => ({ status: 200, ok: true, json: () => new Promise(() => {}) }), { timeoutMs: 5 }).getUsage(), hasCode('transport_error'));
});

test('malformed JSON and interrupted response have safe, distinct errors', async () => {
  await assert.rejects(client(async () => new Response('invalid-secret')).getUsage(), hasCode('invalid_response'));
  await assert.rejects(client(async () => ({ status: 200, ok: true, json: async () => { throw new Error('stream-secret'); } })).getUsage(), hasCode('transport_error'));
});

test('a caller retry after uncertain transport preserves the supplied logical request ID', async () => {
  const bodies = [];
  const c = client(async (_url, init) => {
    bodies.push(init.body);
    if (bodies.length === 1) throw new Error('synthetic disconnect');
    return json({ code: 'already_redeemed', windows_reset: 2 });
  });
  await assert.rejects(c.redeemReset('credit', 'same-attempt'), hasCode('transport_error'));
  assert.deepEqual(await c.redeemReset('credit', 'same-attempt'), { outcome: 'already_redeemed', windowsReset: 2 });
  assert.equal(bodies[0], bodies[1]);
});

test('client captures credential values rather than using a mutable caller object', async () => {
  const c = credentials();
  const instance = new CodexClient(c, { now: () => now, fetch: async (_url, init) => { assert.equal(init.headers['chatgpt-account-id'], 'synthetic-account'); return json({}); } });
  c.accountId = 'other'; c.expires = 0;
  await instance.getUsage();
});
