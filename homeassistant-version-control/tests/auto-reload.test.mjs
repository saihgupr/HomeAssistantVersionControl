// Auto-reload: after an automatic backup, HAVC calls the matching Home
// Assistant reload service for the files that changed.
//
// Run: npm test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.js');

let sandbox;

before(async () => {
  sandbox = await mkdtemp(path.join(tmpdir(), 'havc-auto-reload-'));
  await mkdir(path.join(sandbox, 'home'), { recursive: true });
});

after(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

function gitEnv() {
  return { ...process.env, HOME: path.join(sandbox, 'home'), GIT_CONFIG_NOSYSTEM: '1' };
}

async function createConfig(name) {
  const config = path.join(sandbox, name);
  await mkdir(config, { recursive: true });
  await writeFile(path.join(config, 'configuration.yaml'), 'homeassistant:\n');
  await writeFile(path.join(config, 'automations.yaml'), '[]\n');
  return config;
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function startFakeHomeAssistant() {
  const calls = [];
  const server = createHttpServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      calls.push({
        method: req.method,
        url: req.url,
        auth: req.headers.authorization,
        body,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function startServer(config, { haUrl, autoReload, dataPath }) {
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER_JS], {
    cwd: path.dirname(SERVER_JS),
    env: {
      ...gitEnv(),
      CONFIG_PATH: config,
      PORT: String(port),
      HOST: '127.0.0.1',
      SUPERVISOR_TOKEN: 'test-token',
      HA_URL: haUrl,
      AUTO_RELOAD: String(autoReload),
      ...(dataPath ? { DATA_PATH: dataPath } : {}),
      DEBOUNCE_TIME: '1',
      DEBOUNCE_TIME_UNIT: 'seconds',
      WATCHER_INTERVAL: '100',
      WATCHER_USE_POLLING: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });

  const base = `http://127.0.0.1:${port}/api`;
  const server = {
    base,
    output: () => output,
    async get(route) {
      const res = await fetch(`${base}${route}`);
      return { status: res.status, body: await res.json() };
    },
    async post(route, body) {
      const res = await fetch(`${base}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    },
    async historyLength() {
      const res = await this.get('/git/history');
      return typeof res.body.log?.total === 'number' ? res.body.log.total : 0;
    },
    async stop() {
      if (child.exitCode !== null) return;
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
    },
  };

  await waitFor(async () => {
    try {
      const res = await server.get('/health');
      return res.body.gitInitialized && res.body.fileWatcherActive;
    } catch {
      return false;
    }
  }, 15000, () => `server did not initialise:\n${output}`);

  return server;
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

async function waitForCommit(server, previousLength) {
  await waitFor(async () => (await server.historyLength()) > previousLength, 15000, () => (
    `no commit after ${previousLength} existing commits:\n${server.output()}`
  ));
}

test('auto-reload is off by default and can be enabled at runtime', async (t) => {
  const ha = await startFakeHomeAssistant();
  const config = await createConfig('toggle');
  const server = await startServer(config, { haUrl: ha.url, autoReload: false });

  t.after(async () => {
    await server.stop();
    await ha.close();
  });

  const initialCommits = await server.historyLength();

  await writeFile(path.join(config, 'automations.yaml'), '[]\n# edit one\n');
  await waitForCommit(server, initialCommits);
  assert.equal(ha.calls.length, 0, 'no reload should run while the setting is off');

  const enabled = await server.post('/runtime-settings', { autoReload: true });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.body.settings.autoReload, true);

  const beforeSecondEdit = await server.historyLength();
  await writeFile(path.join(config, 'automations.yaml'), '[]\n# edit two\n');
  await waitForCommit(server, beforeSecondEdit);

  await waitFor(() => ha.calls.length > 0, 10000, () => (
    `automation.reload was not called:\n${server.output()}`
  ));

  assert.equal(ha.calls[0].method, 'POST');
  assert.equal(ha.calls[0].url, '/api/services/automation/reload');
  assert.equal(ha.calls[0].auth, 'Bearer test-token');
});

test('one changed file can reload more than one domain', async (t) => {
  const ha = await startFakeHomeAssistant();
  const config = await createConfig('multi');
  await writeFile(path.join(config, 'lights.yaml'), '[]\n');
  const server = await startServer(config, { haUrl: ha.url, autoReload: true });

  t.after(async () => {
    await server.stop();
    await ha.close();
  });

  const initialCommits = await server.historyLength();
  await writeFile(path.join(config, 'lights.yaml'), '[]\n# edit\n');
  await waitForCommit(server, initialCommits);

  await waitFor(() => ha.calls.length >= 2, 10000, () => (
    `expected template.reload and group.reload:\n${server.output()}`
  ));

  const urls = ha.calls.map((call) => call.url);
  assert.deepEqual(urls.sort(), [
    '/api/services/group/reload',
    '/api/services/template/reload',
  ]);
});

test('the add-on auto_reload option enables reloads', async (t) => {
  const ha = await startFakeHomeAssistant();
  const config = await createConfig('addon-option');
  const dataPath = path.join(sandbox, 'data-addon-option');
  await mkdir(dataPath, { recursive: true });
  await writeFile(path.join(dataPath, 'options.json'), JSON.stringify({ auto_reload: true }));

  const server = await startServer(config, {
    haUrl: ha.url,
    autoReload: false,
    dataPath,
  });

  t.after(async () => {
    await server.stop();
    await ha.close();
  });

  const initialCommits = await server.historyLength();
  await writeFile(path.join(config, 'automations.yaml'), '[]\n# addon option\n');
  await waitForCommit(server, initialCommits);

  await waitFor(() => ha.calls.length > 0, 10000, () => (
    `add-on auto_reload did not trigger automation.reload:\n${server.output()}`
  ));

  assert.equal(ha.calls[0].url, '/api/services/automation/reload');
});
