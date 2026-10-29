// Installed-package smoke test. Only a deliberately missing temporary auth file is used.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const binary = process.argv[2];
const directory = await mkdtemp(join(tmpdir(), 'codex-auto-reset-installed-'));
try {
  const help = spawnSync(binary, ['--help'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage: codex-auto-reset/);

  const auth = join(directory, 'missing-auth.json');
  const status = spawnSync(binary, ['status', '--auth-file', auth, '--json'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(status.status, 1, status.stderr);
  assert.equal(JSON.parse(status.stdout).error.code, 'credential_read_error');

  // Exercise all installed workspace imports and graceful shutdown without contacting the backend.
  const child = spawn(binary, ['daemon', '--auth-file', auth, '--json']);
  let output = '', stderr = '';
  child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  const finished = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  let stopped = false;
  child.stdout.setEncoding('utf8').on('data', text => {
    output += text;
    if (!stopped && output.includes('credential_read_error')) {
      stopped = true;
      child.kill('SIGTERM');
    }
  });
  try {
    const exit = await finished;
    assert.equal(exit.code, 0, `${stderr}\n${output}`);
    assert.equal(exit.signal, null);
    const events = output.trim().split('\n').map(line => JSON.parse(line));
    for (const code of ['daemon_started', 'credential_read_error', 'daemon_stopped']) {
      assert.ok(events.some(event => event.code === code), `Missing ${code}`);
    }
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
