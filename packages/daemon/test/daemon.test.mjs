import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ResetDaemon, validateTiming, runDaemon } from '../dist/index.js';
import { AppError, HttpError } from '../../core/dist/index.js';

function fixture(options = {}) {
  let now = 1_000_000;
  let account = 'account-a';
  let expires = now + 3_600_000;
  let credits = [];
  let outcome = 'reset';
  let postError;
  let readCount = 0;
  let onRead;
  let listError;
  let usageError;
  const events = [], posts = [], lists = [];
  let nextId = 0;
  const client = {
    async listResetCredits() {
      lists.push(now);
      if (listError) throw listError;
      return { availableCount: credits.length, credits: structuredClone(credits) };
    },
    async getUsage() {
      if (usageError) throw usageError;
      return { planType: null, primary: null, secondary: null, resetCreditsAvailable: credits.length };
    },
    async redeemReset(id, requestId) {
      posts.push({ id, requestId, account });
      if (postError) throw postError;
      return { outcome, windowsReset: outcome === 'reset' ? 1 : 0 };
    },
  };
  const deps = {
    now: () => now,
    randomUUID: () => `attempt-${++nextId}`,
    readCredentials: async () => {
      readCount++;
      onRead?.(readCount);
      return { access: 'synthetic-token', refresh: 'synthetic-refresh', accountId: account, expires };
    },
    createClient: () => client,
  };
  const daemon = new ResetDaemon({ onEvent: e => events.push(e), ...options }, deps);
  return {
    daemon, deps, events, posts, lists,
    credit(id, remaining, extra = {}) {
      return { id, resetType: 'codex_rate_limits', status: 'available', expiresAt: now + remaining, title: null, description: null, ...extra };
    },
    set credits(value) { credits = value; },
    set outcome(value) { outcome = value; },
    set postError(value) { postError = value; },
    set listError(value) { listError = value; },
    set usageError(value) { usageError = value; },
    set expires(value) { expires = value; },
    set account(value) { account = value; },
    set onRead(value) { onRead = value; },
    advance(ms) { now += ms; },
    get now() { return now; },
  };
}

test('timing validation enforces at least two scheduled opportunities', () => {
  validateTiming(300_000, 900_000);
  validateTiming(450_000, 900_000);
  for (const values of [[0, 900_000], [-1, 900_000], [500_000, 900_000], [NaN, 900_000], [1, Infinity], [2 ** 32, 2 ** 34]]) {
    assert.throws(() => validateTiming(...values));
  }
});

test('startup polls immediately and redeems a credit expiring before next tick', async () => {
  const controller = new AbortController();
  const f = fixture();
  f.credits = [f.credit('soon', 30_000)];
  await runDaemon({ signal: controller.signal }, { ...f.deps, sleep: async () => controller.abort() });
  assert.equal(f.posts.length, 1);
  assert.equal(f.posts[0].id, 'soon');
});

test('only earliest eligible credit is redeemed per poll; fresh list detects manual redemption', async () => {
  const f = fixture();
  f.credits = [f.credit('later', 600_000), f.credit('earlier', 200_000)];
  await f.daemon.poll();
  assert.deepEqual(f.posts.map(p => p.id), ['earlier']);
  f.credits = []; // User redeemed later elsewhere.
  await f.daemon.poll();
  assert.equal(f.posts.length, 1);
});

test('credits outside lead time, expired, unknown expiry, unavailable, or other types are skipped', async () => {
  const f = fixture();
  f.credits = [f.credit('late', 900_001), f.credit('expired', 0), f.credit('unknown', 1, { expiresAt: null }),
    f.credit('unavailable', 1, { status: 'redeemed' }), f.credit('other', 1, { resetType: 'other' })];
  await f.daemon.poll();
  assert.equal(f.posts.length, 0);
});

test('expired credentials warn, keep polling, and recover after Pi updates file', async () => {
  const f = fixture();
  f.credits = [f.credit('soon', 600_000)];
  f.expires = f.now - 1;
  await f.daemon.poll();
  assert.equal(f.lists.length, 0);
  assert.ok(f.events.some(e => e.code === 'token_expired'));
  f.expires = f.now + 3_600_000;
  await f.daemon.poll();
  assert.equal(f.posts.length, 1);
});

test('no stale redemption after listing failure, and arbitrary errors are redacted', async () => {
  const f = fixture();
  f.credits = [f.credit('soon', 600_000)];
  f.listError = new Error('Authorization: Bearer secret-token');
  await f.daemon.poll();
  assert.equal(f.posts.length, 0);
  assert.ok(!JSON.stringify(f.events).includes('secret-token'));
});

test('uncertain retries reuse UUID; concurrent polls are single-flight', async () => {
  const f = fixture();
  f.credits = [f.credit('soon', 600_000)];
  f.postError = new Error('network failure');
  await Promise.all([f.daemon.poll(), f.daemon.poll()]);
  assert.equal(f.posts.length, 1);
  f.postError = undefined;
  await f.daemon.poll();
  assert.equal(f.posts.length, 2);
  assert.equal(f.posts[0].requestId, f.posts[1].requestId);
});

test('nothing_to_reset and unknown responses suppress a credit until restart', async () => {
  const f = fixture();
  f.credits = [f.credit('soon', 600_000)];
  f.outcome = 'nothing_to_reset';
  await f.daemon.poll();
  await f.daemon.poll();
  assert.equal(f.posts.length, 1);
  const other = fixture();
  other.credits = [other.credit('soon', 600_000)];
  other.postError = new AppError('unknown_redemption_outcome', 'Unknown response.');
  await other.daemon.poll();
  await other.daemon.poll();
  assert.equal(other.posts.length, 1);
});

test('no_credit re-fetches without sending another POST in same poll', async () => {
  const f = fixture();
  f.credits = [f.credit('soon', 600_000)];
  f.outcome = 'no_credit';
  await f.daemon.poll();
  assert.equal(f.posts.length, 1);
  assert.equal(f.lists.length, 2);
});

test('successful mutation is not retried if subsequent usage refresh fails', async () => {
  const f = fixture();
  f.credits = [f.credit('soon', 600_000)];
  f.usageError = new Error('usage GET failed');
  await f.daemon.poll();
  await f.daemon.poll();
  assert.equal(f.posts.length, 1);
  assert.ok(f.events.some(e => e.code === 'post_redemption_refresh_failed'));
});

test('account switch does not reuse another account request UUID', async () => {
  const f = fixture();
  f.credits = [f.credit('same-id', 600_000)];
  f.postError = new Error('network failure');
  await f.daemon.poll();
  f.account = 'account-b';
  f.postError = undefined;
  await f.daemon.poll();
  assert.notEqual(f.posts[0].requestId, f.posts[1].requestId);
  assert.ok(f.events.some(e => e.code === 'account_changed'));
});

test('account switch between list and POST defers redemption', async () => {
  const f = fixture();
  f.credits = [f.credit('soon', 600_000)];
  f.onRead = count => { if (count === 2) f.account = 'account-b'; };
  await f.daemon.poll();
  assert.equal(f.posts.length, 0);
});

test('uncertain credit is never retried after expiry', async () => {
  const f = fixture();
  f.credits = [f.credit('soon', 10_000)];
  f.postError = new Error('timeout');
  await f.daemon.poll();
  f.advance(11_000);
  f.credits = [];
  await f.daemon.poll();
  assert.equal(f.posts.length, 1);
  assert.ok(f.events.some(e => e.code === 'redemption_unresolved'));
});

test('request time does not silently lengthen the configured polling period', async () => {
  const f = fixture();
  f.onRead = () => f.advance(10_000);
  assert.equal(await f.daemon.poll(), 290_000);
});

test('Retry-After gates subsequent polls and resumes afterward', async () => {
  const f = fixture();
  f.credits = [f.credit('soon', 800_000)];
  f.listError = new HttpError(429, 600_000);
  assert.equal(await f.daemon.poll(), 600_000);
  f.listError = undefined;
  f.advance(300_000);
  await f.daemon.poll();
  assert.equal(f.lists.length, 1);
  assert.equal(f.posts.length, 0);
  f.advance(300_000);
  await f.daemon.poll();
  assert.equal(f.posts.length, 1);
});

test('Retry-After from a POST retains the UUID and delays retry', async () => {
  const f = fixture();
  f.credits = [f.credit('soon', 800_000)];
  f.postError = new HttpError(429, 600_000);
  assert.equal(await f.daemon.poll(), 600_000);
  f.postError = undefined;
  f.advance(600_000);
  await f.daemon.poll();
  assert.equal(f.posts.length, 2);
  assert.equal(f.posts[0].requestId, f.posts[1].requestId);
});

test('HTTP rejection can recover on a subsequent fresh poll without changing the UUID', async () => {
  for (const status of [400, 401, 403, 404, 408, 409, 429, 500, 503]) {
    const f = fixture();
    f.credits = [f.credit('soon', 600_000)];
    f.postError = new HttpError(status, null);
    await f.daemon.poll();
    f.postError = undefined;
    await f.daemon.poll();
    assert.equal(f.posts.length, 2, `status ${status} should not permanently suppress the credit`);
    assert.equal(f.posts[0].requestId, f.posts[1].requestId);
  }
});

test('long Retry-After waits are chunked safely and cancellation stops the wait', async () => {
  const controller = new AbortController();
  const f = fixture();
  const maxTimer = 2_147_483_647;
  const waits = [];
  f.listError = new HttpError(429, maxTimer + 1000);
  await runDaemon({ signal: controller.signal }, {
    ...f.deps,
    sleep: async ms => {
      waits.push(ms);
      f.advance(ms);
      if (waits.length === 2) controller.abort();
    },
  });
  assert.deepEqual(waits, [maxTimer, 1000]);
  assert.equal(f.lists.length, 1);
});

test('a still-pending attempt does not block a different available credit', async () => {
  const f = fixture();
  f.credits = [f.credit('first', 600_000)];
  f.postError = new Error('timeout');
  await f.daemon.poll();
  f.credits = [f.credit('second', 700_000)];
  f.postError = undefined;
  await f.daemon.poll();
  assert.deepEqual(f.posts.map(post => post.id), ['first', 'second']);
});

test('restart loses suppression history by design', async () => {
  const f = fixture();
  f.credits = [f.credit('soon', 600_000)];
  f.outcome = 'nothing_to_reset';
  await f.daemon.poll();
  await f.daemon.poll();
  assert.equal(f.posts.length, 1);
  await new ResetDaemon({}, f.deps).poll();
  assert.equal(f.posts.length, 2);
});

test('abort before polling makes no request', async () => {
  const controller = new AbortController();
  controller.abort();
  const f = fixture({ signal: controller.signal });
  f.credits = [f.credit('soon', 30_000)];
  await f.daemon.poll();
  assert.equal(f.lists.length, 0);
});
