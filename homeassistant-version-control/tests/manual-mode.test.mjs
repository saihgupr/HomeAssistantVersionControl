// Regression tests for manual mode: HAVC must never mutate a user-managed repository
// (history, index, .gitignore, remotes) unless the user explicitly commits.
//
// Each test boots the real server against a throwaway git repo. HOME is sandboxed so
// `git config --global` writes can't leak into the machine running the tests.
//
// Run: npm test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.js');
const USER_GITIGNORE = '# user-managed ignore file\n*.log\n';

let sandbox;

before(async () => {
  sandbox = await mkdtemp(path.join(tmpdir(), 'havc-manual-mode-'));
});

after(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv() }).trim();
}

function gitEnv() {
  return { ...process.env, HOME: path.join(sandbox, 'home'), GIT_CONFIG_NOSYSTEM: '1' };
}

/** An existing, user-managed repo: custom .gitignore, a tracked .storage file, an origin remote. */
async function createUserRepo(name) {
  const root = path.join(sandbox, name);
  const config = path.join(root, 'config');
  const remote = path.join(root, 'remote.git');
  await mkdir(path.join(config, '.storage'), { recursive: true });
  await mkdir(path.join(sandbox, 'home'), { recursive: true });

  await writeFile(path.join(config, '.gitignore'), USER_GITIGNORE);
  await writeFile(path.join(config, 'configuration.yaml'), 'homeassistant:\n');
  await writeFile(path.join(config, 'automations.yaml'), '[]\n');
  await writeFile(path.join(config, '.storage', 'core.entity_registry'), '{}\n');

  git(root, 'init', '--bare', '-b', 'main', remote);
  git(config, 'init', '-b', 'main');
  git(config, 'config', 'user.name', 'Test User');
  git(config, 'config', 'user.email', 'test@example.com');
  git(config, 'add', '.');
  git(config, 'commit', '-m', 'user commit');
  git(config, 'remote', 'add', 'origin', remote);
  git(config, 'push', '-q', '-u', 'origin', 'main');

  return { config, remote };
}

async function snapshot({ config, remote }) {
  return {
    head: git(config, 'rev-parse', 'HEAD'),
    commitCount: git(config, 'rev-list', '--count', 'HEAD'),
    trackedFiles: git(config, 'ls-files'),
    gitignore: await readFile(path.join(config, '.gitignore'), 'utf8'),
    originUrl: git(config, 'remote', 'get-url', 'origin'),
    remoteHead: git(remote, 'rev-parse', 'main'),
  };
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

async function startServer(config, { manualMode }) {
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER_JS], {
    cwd: path.dirname(SERVER_JS),
    env: {
      ...gitEnv(),
      CONFIG_PATH: config,
      PORT: String(port),
      HOST: '127.0.0.1',
      MANUAL_MODE: String(manualMode),
      DEBOUNCE_TIME: '1',
      DEBOUNCE_TIME_UNIT: 'seconds',
      WATCHER_INTERVAL: '200',
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
    async post(route, body) {
      const res = await fetch(`${base}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    },
    async health() {
      return (await fetch(`${base}/health`)).json();
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
      return (await server.health()).gitInitialized;
    } catch {
      return false;
    }
  }, 15000, () => `server did not initialise:\n${output}`);
  // initRepo resolves before the watcher is started; give the .then() a tick to run.
  await new Promise((r) => setTimeout(r, 200));
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

/** The body the settings modal sends on "Save" (public/app.js saveSettings). */
function uiSettingsPayload(manualMode) {
  return {
    debounceTime: 3,
    debounceTimeUnit: 'seconds',
    historyRetention: false,
    retentionType: 'time',
    retentionValue: 30,
    retentionUnit: 'days',
    limitHistory: false,
    maxCommits: 500,
    manualMode,
    extensions: {
      include: ['yaml', 'yml'],
      exclude: ['secrets.yaml'],
      excludeFolders: [],
      storage: ['lovelace', 'lovelace_dashboards', 'lovelace_resources', 'lovelace.*'],
    },
    legacyArrowDirection: false,
  };
}

test('startup in manual mode leaves an existing repo untouched', async (t) => {
  const repo = await createUserRepo('startup');
  const before = await snapshot(repo);
  const server = await startServer(repo.config, { manualMode: true });
  t.after(() => server.stop());

  assert.deepEqual(await snapshot(repo), before);
  assert.equal((await server.health()).fileWatcherActive, false);
});

test('saving settings in manual mode does not rewrite .gitignore, untrack files or commit', async (t) => {
  const repo = await createUserRepo('settings');
  const server = await startServer(repo.config, { manualMode: true });
  t.after(() => server.stop());
  const before = await snapshot(repo);

  const res = await server.post('/runtime-settings', uiSettingsPayload(true));

  assert.equal(res.status, 200);
  assert.deepEqual(await snapshot(repo), before);
});

test('cloud sync cannot touch the remote, .gitignore or history in manual mode', async (t) => {
  const repo = await createUserRepo('cloud-sync');
  const server = await startServer(repo.config, { manualMode: true });
  t.after(() => server.stop());
  const before = await snapshot(repo);

  const settings = await server.post('/cloud-sync/settings', {
    enabled: true,
    authProvider: 'generic',
    remoteUrl: 'https://example.invalid/other.git',
    authToken: 'secret-token',
    pushFrequency: 'manual',
  });
  const testConn = await server.post('/cloud-sync/test', { remoteUrl: 'https://example.invalid/other.git' });
  const push = await server.post('/cloud-sync/push', { force: true });
  const disconnect = await server.post('/github/disconnect', {});

  assert.equal(settings.body.success, false, 'cloud sync settings should be refused');
  assert.equal(testConn.body.success, false, 'connection test should be refused');
  assert.equal(push.body.success, false, 'push should be refused');
  assert.equal(disconnect.body.success, true, 'disconnect only clears HAVC settings');
  assert.deepEqual(await snapshot(repo), before);
});

test('switching to manual mode at runtime stops auto-commits; switching back resumes them', async (t) => {
  const repo = await createUserRepo('toggle');
  const server = await startServer(repo.config, { manualMode: false });
  t.after(() => server.stop());
  const automations = path.join(repo.config, 'automations.yaml');
  const commitCount = () => Number(git(repo.config, 'rev-list', '--count', 'HEAD'));

  // Positive control: in auto mode the watcher commits an edit.
  const autoBaseline = commitCount();
  await writeFile(automations, '[] # auto mode edit\n');
  await waitFor(() => commitCount() > autoBaseline, 15000,
    () => `watcher never auto-committed in auto mode:\n${server.output()}`);

  await server.post('/runtime-settings', uiSettingsPayload(true));
  assert.equal((await server.health()).fileWatcherActive, false);

  const manualBaseline = commitCount();
  await writeFile(automations, '[] # manual mode edit\n');
  const committed = await waitFor(() => commitCount() > manualBaseline, 6000);
  assert.equal(committed, false, 'watcher auto-committed after switching to manual mode');

  await server.post('/runtime-settings', uiSettingsPayload(false));
  assert.equal((await server.health()).fileWatcherActive, true);
});
