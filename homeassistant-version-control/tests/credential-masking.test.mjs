// Regression test for Issue #51: Remote URLs with embedded credentials must never be leaked in clear text
// across startup logs, runtime settings updates, or git remote initialization.
//
// Run: npm test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.js');

let sandbox;

before(async () => {
  sandbox = await mkdtemp(path.join(tmpdir(), 'havc-mask-test-'));
});

after(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

function freePort() {
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

test('startup masks embedded tokens in config.remote_url and options.json', async (t) => {
  const root = path.join(sandbox, 'startup-test');
  const configDir = path.join(root, 'config');
  const dataDir = path.join(root, 'data');
  const homeDir = path.join(root, 'home');
  await mkdir(configDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(path.join(configDir, '.storage'), { recursive: true });

  await writeFile(path.join(configDir, 'configuration.yaml'), 'homeassistant:\n');
  await writeFile(path.join(configDir, 'automations.yaml'), '[]\n');
  await writeFile(path.join(configDir, '.storage', 'core.entity_registry'), '{}\n');

  const SECRET_TOKEN = 'ghp_STARTUP_SECRET_999888777666';
  const RAW_URL = `https://${SECRET_TOKEN}@github.com/org/repo.git`;

  await writeFile(path.join(dataDir, 'options.json'), JSON.stringify({
    remote_url: RAW_URL,
    manual_mode: false,
    include_extensions: ['yaml']
  }));

  const port = await freePort();
  const child = spawn(process.execPath, [SERVER_JS], {
    cwd: path.dirname(SERVER_JS),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      CONFIG_PATH: configDir,
      DATA_PATH: dataDir,
      HOME: homeDir,
      GIT_CONFIG_NOSYSTEM: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGTERM'));

  let logs = '';
  child.stdout.on('data', (d) => { logs += d.toString(); });
  child.stderr.on('data', (d) => { logs += d.toString(); });

  const deadline = Date.now() + 15000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }

  assert.ok(ready, `Server failed to start:\n${logs}`);
  assert.ok(!logs.includes(SECRET_TOKEN), `Secret token was leaked in startup logs:\n${logs}`);
  assert.ok(logs.includes('https://***@github.com/org/repo.git'), `Masked URL not found in logs:\n${logs}`);
});

test('cloud-sync settings endpoint masks embedded url tokens and redacts authTokens in logs', async (t) => {
  const root = path.join(sandbox, 'settings-test');
  const configDir = path.join(root, 'config');
  const dataDir = path.join(root, 'data');
  const homeDir = path.join(root, 'home');
  await mkdir(configDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(path.join(configDir, '.storage'), { recursive: true });

  await writeFile(path.join(configDir, 'configuration.yaml'), 'homeassistant:\n');
  await writeFile(path.join(configDir, 'automations.yaml'), '[]\n');
  await writeFile(path.join(configDir, '.storage', 'core.entity_registry'), '{}\n');

  const port = await freePort();
  const child = spawn(process.execPath, [SERVER_JS], {
    cwd: path.dirname(SERVER_JS),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      CONFIG_PATH: configDir,
      DATA_PATH: dataDir,
      HOME: homeDir,
      GIT_CONFIG_NOSYSTEM: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGTERM'));

  let logs = '';
  child.stdout.on('data', (d) => { logs += d.toString(); });
  child.stderr.on('data', (d) => { logs += d.toString(); });

  const base = `http://127.0.0.1:${port}/api`;
  const deadline = Date.now() + 15000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }

  assert.ok(ready, `Server failed to start:\n${logs}`);

  const SECRET_URL_TOKEN = 'ghp_SECRET_URL_TOKEN_111222333';
  const SECRET_AUTH_TOKEN = 'github_pat_SECRET_AUTH_TOKEN_444555';
  const TEST_URL = `https://${SECRET_URL_TOKEN}@github.com/myorg/sync-repo.git`;

  const res = await fetch(`${base}/cloud-sync/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      enabled: true,
      remoteUrl: TEST_URL,
      authToken: SECRET_AUTH_TOKEN,
      authProvider: 'github',
    }),
  });
  assert.equal(res.status, 200);

  // Allow log flush
  await new Promise((r) => setTimeout(r, 300));

  assert.ok(!logs.includes(SECRET_URL_TOKEN), `Secret URL token was leaked in logs:\n${logs}`);
  assert.ok(!logs.includes(SECRET_AUTH_TOKEN), `Secret auth token was leaked in logs:\n${logs}`);
  assert.ok(logs.includes('https://***@github.com/myorg/sync-repo.git'), `Masked URL not found in logs:\n${logs}`);
});

