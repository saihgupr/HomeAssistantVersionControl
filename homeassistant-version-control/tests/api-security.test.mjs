// Security regression tests for the API surface: basic auth, path containment,
// commit-ish validation and header echo.
//
// Each test boots the real server against a throwaway config directory. HOME is
// sandboxed so `git config --global` writes can't leak into the machine running
// the tests.
//
// Run: node --test tests/api-security.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.js');
const USERNAME = 'test';
const PASSWORD = 'secret';
const AUTH_HEADER = `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64')}`;
const SECRET_CONTENT = 'outside-the-config-root-4f10ce7';

let sandbox;
let configRoot;
let child;
let base;
let output = '';

before(async () => {
  sandbox = await mkdtemp(path.join(tmpdir(), 'havc-api-security-'));
  configRoot = path.join(sandbox, 'config');
  const dataRoot = path.join(sandbox, 'data');
  await mkdir(configRoot, { recursive: true });
  await mkdir(dataRoot, { recursive: true });
  await mkdir(path.join(sandbox, 'home'), { recursive: true });
  await writeFile(path.join(configRoot, 'configuration.yaml'), 'homeassistant:\n');
  // Deliberately outside CONFIG_PATH: traversal attempts must never reach it.
  await writeFile(path.join(sandbox, 'secret.yaml'), `api_key: ${SECRET_CONTENT}\n`);

  const port = await freePort();
  child = spawn(process.execPath, [SERVER_JS], {
    cwd: path.dirname(SERVER_JS),
    env: {
      ...process.env,
      HOME: path.join(sandbox, 'home'),
      GIT_CONFIG_NOSYSTEM: '1',
      CONFIG_PATH: configRoot,
      DATA_PATH: dataRoot,
      PORT: String(port),
      HOST: '127.0.0.1',
      MANUAL_MODE: 'true',
      DEBOUNCE_TIME: '1',
      DEBOUNCE_TIME_UNIT: 'seconds',
      WATCHER_INTERVAL: '200',
      HAVC_API_AUTH: 'on',
      HAVC_USERNAME: USERNAME,
      HAVC_PASSWORD: PASSWORD,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });

  base = `http://127.0.0.1:${port}/api`;

  await waitFor(async () => {
    try {
      const res = await api('/health');
      if (res.status !== 200) return false;
      return (await res.json()).gitInitialized === true;
    } catch {
      return false;
    }
  }, 15000, () => `server did not initialise:\n${output}`);
});

after(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await exited;
  }
  if (sandbox) await rm(sandbox, { recursive: true, force: true });
});

function api(route, { method = 'GET', body, headers = {}, authenticated = true } = {}) {
  const requestHeaders = { ...headers };
  if (authenticated && !requestHeaders.Authorization) requestHeaders.Authorization = AUTH_HEADER;
  if (body !== undefined) requestHeaders['Content-Type'] = 'application/json';

  return fetch(`${base}${route}`, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (message) assert.fail(message());
  return false;
}

test('API and app require basic auth, healthz stays open', async () => {
  const unauthorized = await fetch(`${base}/app-settings`);
  assert.equal(unauthorized.status, 401);
  assert.match(unauthorized.headers.get('www-authenticate') || '', /^Basic\b/);
  assert.deepEqual(await unauthorized.json(), {
    success: false,
    error: 'Authentication required',
  });

  // The app itself is protected too, so mobile webviews get a prompt on load.
  const spa = await fetch(base.replace(/\/api$/, '/'));
  assert.equal(spa.status, 401);

  // The container healthcheck stays unauthenticated.
  const healthz = await fetch(base.replace(/\/api$/, '/healthz'));
  assert.equal(healthz.status, 200);
  assert.deepEqual(await healthz.json(), { status: 'ok' });
});

test('wrong credentials are rejected, correct credentials are accepted', async () => {
  const wrongPassword = `Basic ${Buffer.from(`${USERNAME}:not-the-password`).toString('base64')}`;
  const rejected = await api('/app-settings', { headers: { Authorization: wrongPassword } });
  assert.equal(rejected.status, 401);

  const accepted = await api('/app-settings');
  assert.equal(accepted.status, 200);
  const settings = await accepted.json();
  assert.equal(settings.apiAuthEnabled, true);
  assert.equal(settings.apiAuthMode, 'basic');
});

test('file-content rejects traversal outside the config root', async () => {
  const positive = await api('/file-content?filePath=configuration.yaml');
  const positiveBody = await positive.json();
  assert.equal(positive.status, 200, JSON.stringify(positiveBody));
  assert.equal(positiveBody.content, 'homeassistant:\n');

  const traversals = [
    '../secret.yaml',
    // URL-encoded ../ and /
    '%2e%2e%2fsecret.yaml',
    '..%2F..%2Fsecret.yaml',
    '%2e%2e/%2e%2e/etc/passwd',
  ];

  for (const traversal of traversals) {
    const res = await api(`/file-content?filePath=${traversal}`);
    assert.equal(res.status, 400, `expected 400 for ${traversal}`);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.doesNotMatch(JSON.stringify(body), new RegExp(SECRET_CONTENT));
  }
});

test('file-at-commit rejects git option injection in commitHash', async () => {
  const outputPath = path.join(sandbox, 'pwn');
  const res = await api(
    `/git/file-at-commit?commitHash=${encodeURIComponent(`--output=${outputPath}`)}&filePath=configuration.yaml`
  );

  assert.equal(res.status, 400);
  assert.equal((await res.json()).success, false);
});

test('list-yaml-files refuses a liveConfigPath outside CONFIG_PATH', async () => {
  const res = await api('/list-yaml-files', {
    method: 'POST',
    body: { liveConfigPath: '/etc' },
  });

  assert.equal(res.status, 400);
  assert.equal((await res.json()).success, false);
});

test('health does not echo request headers', async () => {
  const res = await api('/health');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal('headers' in body, false);
});
