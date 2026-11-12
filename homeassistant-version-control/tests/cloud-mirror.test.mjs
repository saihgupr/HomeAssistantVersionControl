import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.js');
let sandbox;

before(async () => {
  sandbox = await mkdtemp(path.join(tmpdir(), 'havc-cloud-mirror-'));
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

async function createRepoWithRemotes(name) {
  const root = path.join(sandbox, name);
  const config = path.join(root, 'config');
  const originRemote = path.join(root, 'origin.git');
  const mirrorRemote = path.join(root, 'mirror.git');

  await mkdir(path.join(config, '.storage'), { recursive: true });
  await mkdir(path.join(sandbox, 'home'), { recursive: true });

  git(root, 'init', '--bare', '-b', 'main', originRemote);
  git(root, 'init', '--bare', '-b', 'main', mirrorRemote);

  git(config, 'init', '-b', 'main');
  git(config, 'config', 'user.name', 'Test User');
  git(config, 'config', 'user.email', 'test@example.com');
  await writeFile(path.join(config, 'configuration.yaml'), 'homeassistant:\n');
  git(config, 'add', '.');
  git(config, 'commit', '-m', 'initial commit');
  git(config, 'remote', 'add', 'origin', originRemote);
  git(config, 'push', '-q', '-u', 'origin', 'main');

  return { config, originRemote, mirrorRemote };
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

async function startServer(config, { manualMode = false, env = {} } = {}) {
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
      ...env,
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
    async get(route) {
      const res = await fetch(`${base}${route}`);
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

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      if ((await server.health()).gitInitialized) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((r) => setTimeout(r, 200));
  return server;
}

test('configuring mirrorUrl manages mirror remote and does not modify origin', async (t) => {
  const repo = await createRepoWithRemotes('test-config');
  const server = await startServer(repo.config, { manualMode: false });
  t.after(() => server.stop());

  const res = await server.post('/cloud-sync/settings', {
    enabled: true,
    authProvider: 'generic',
    remoteUrl: repo.originRemote,
    mirrorUrl: repo.mirrorRemote,
  });

  assert.equal(res.body.success, true);
  assert.equal(git(repo.config, 'remote', 'get-url', 'origin'), repo.originRemote);
  assert.equal(git(repo.config, 'remote', 'get-url', 'mirror'), repo.mirrorRemote);

  const getSettings = await server.get('/cloud-sync/settings');
  assert.equal(getSettings.body.settings.mirrorUrl, repo.mirrorRemote);
});

test('pushToRemote pushes to both origin and mirror when mirror is configured', async (t) => {
  const repo = await createRepoWithRemotes('test-sync-both');
  const server = await startServer(repo.config, { manualMode: false });
  t.after(() => server.stop());

  // Configure origin and mirror
  await server.post('/cloud-sync/settings', {
    enabled: true,
    authProvider: 'generic',
    remoteUrl: repo.originRemote,
    mirrorUrl: repo.mirrorRemote,
  });

  // Create a new commit in local repo
  await writeFile(path.join(repo.config, 'automations.yaml'), '- alias: test\n');
  git(repo.config, 'add', 'automations.yaml');
  git(repo.config, 'commit', '-m', 'add automation');
  const localHead = git(repo.config, 'rev-parse', 'HEAD');

  // Trigger push
  const pushRes = await server.post('/cloud-sync/push', { force: true });
  assert.equal(pushRes.body.success, true);

  // Both remotes must have received the new commit!
  assert.equal(git(repo.originRemote, 'rev-parse', 'main'), localHead);
  assert.equal(git(repo.mirrorRemote, 'rev-parse', 'main'), localHead);

  const settings = await server.get('/cloud-sync/settings');
  assert.equal(settings.body.settings.lastPushStatus, 'success');
  assert.equal(settings.body.settings.lastMirrorPushStatus, 'success');
  assert.equal(settings.body.settings.lastMirrorPushError, null);
});

test('mirror push failure is non-fatal: origin push succeeds and status reflects mirror error', async (t) => {
  const repo = await createRepoWithRemotes('test-mirror-failure');
  const server = await startServer(repo.config, { manualMode: false });
  t.after(() => server.stop());

  // Configure mirror with an invalid/unreachable path
  const brokenMirror = 'file:///nonexistent/broken/mirror.git';
  await server.post('/cloud-sync/settings', {
    enabled: true,
    authProvider: 'generic',
    remoteUrl: repo.originRemote,
    mirrorUrl: brokenMirror,
  });

  // Create a new commit in local repo
  await writeFile(path.join(repo.config, 'automations.yaml'), '- alias: mirror-fail-test\n');
  git(repo.config, 'add', 'automations.yaml');
  git(repo.config, 'commit', '-m', 'test non-fatal mirror failure');
  const localHead = git(repo.config, 'rev-parse', 'HEAD');

  // Push should succeed overall despite mirror failure
  const pushRes = await server.post('/cloud-sync/push', { force: true });
  assert.equal(pushRes.body.success, true);

  // Origin MUST have succeeded
  assert.equal(git(repo.originRemote, 'rev-parse', 'main'), localHead);

  // Status must reflect mirror failure without breaking origin
  const settings = await server.get('/cloud-sync/settings');
  assert.equal(settings.body.settings.lastPushStatus, 'success');
  assert.equal(settings.body.settings.lastMirrorPushStatus, 'error');
  assert.ok(settings.body.settings.lastMirrorPushError);
});

test('clearing mirrorUrl removes mirror remote', async (t) => {
  const repo = await createRepoWithRemotes('test-clear-mirror');
  const server = await startServer(repo.config, { manualMode: false });
  t.after(() => server.stop());

  await server.post('/cloud-sync/settings', {
    enabled: true,
    authProvider: 'generic',
    remoteUrl: repo.originRemote,
    mirrorUrl: repo.mirrorRemote,
  });
  assert.equal(git(repo.config, 'remote', 'get-url', 'mirror'), repo.mirrorRemote);

  // Now clear mirror
  await server.post('/cloud-sync/settings', {
    mirrorUrl: '',
  });

  const remotes = git(repo.config, 'remote').split('\n').filter(Boolean);
  assert.ok(!remotes.includes('mirror'), 'mirror remote should be removed');
  assert.ok(remotes.includes('origin'), 'origin remote must remain');
});

test('mirrorEnabled toggle persists even when mirrorUrl is initially empty', async (t) => {
  const repo = await createRepoWithRemotes('test-toggle-persistence');
  const server = await startServer(repo.config, { manualMode: false });
  t.after(() => server.stop());

  // Toggle on without a URL yet
  const res = await server.post('/cloud-sync/settings', {
    mirrorEnabled: true,
    mirrorUrl: '',
  });
  assert.equal(res.body.success, true);

  const settings = await server.get('/cloud-sync/settings');
  assert.equal(settings.body.settings.mirrorEnabled, true);

  // Toggle off
  await server.post('/cloud-sync/settings', {
    mirrorEnabled: false,
    mirrorUrl: '',
  });
  const settingsOff = await server.get('/cloud-sync/settings');
  assert.equal(settingsOff.body.settings.mirrorEnabled, false);
});

test('turning mirrorEnabled OFF keeps mirrorUrl saved but disables pushing to mirror', async (t) => {
  const repo = await createRepoWithRemotes('test-toggle-preserves-url');
  const server = await startServer(repo.config, { manualMode: false });
  t.after(() => server.stop());

  // Configure origin and mirror with mirrorEnabled: true
  await server.post('/cloud-sync/settings', {
    enabled: true,
    authProvider: 'generic',
    remoteUrl: repo.originRemote,
    mirrorEnabled: true,
    mirrorUrl: repo.mirrorRemote,
  });

  // Commit 1 - should push to both
  await writeFile(path.join(repo.config, 'automations.yaml'), '- alias: commit1\n');
  git(repo.config, 'add', 'automations.yaml');
  git(repo.config, 'commit', '-m', 'commit 1');
  const head1 = git(repo.config, 'rev-parse', 'HEAD');
  await server.post('/cloud-sync/push', { force: true });
  assert.equal(git(repo.originRemote, 'rev-parse', 'main'), head1);
  assert.equal(git(repo.mirrorRemote, 'rev-parse', 'main'), head1);

  // Turn mirror toggle OFF - keep mirrorUrl
  await server.post('/cloud-sync/settings', {
    mirrorEnabled: false,
    mirrorUrl: repo.mirrorRemote,
  });

  // Verify settings still preserve mirrorUrl
  const settings = await server.get('/cloud-sync/settings');
  assert.equal(settings.body.settings.mirrorEnabled, false);
  assert.equal(settings.body.settings.mirrorUrl, repo.mirrorRemote);

  // Commit 2 - push should only go to origin, NOT mirror
  await writeFile(path.join(repo.config, 'automations.yaml'), '- alias: commit2\n');
  git(repo.config, 'add', 'automations.yaml');
  git(repo.config, 'commit', '-m', 'commit 2');
  const head2 = git(repo.config, 'rev-parse', 'HEAD');
  await server.post('/cloud-sync/push', { force: true });

  assert.equal(git(repo.originRemote, 'rev-parse', 'main'), head2);
  assert.equal(git(repo.mirrorRemote, 'rev-parse', 'main'), head1, 'mirror remote should remain on commit 1 while toggle is off');

  // Turn mirror toggle back ON
  await server.post('/cloud-sync/settings', {
    mirrorEnabled: true,
    mirrorUrl: repo.mirrorRemote,
  });

  // Commit 3 - should push to both again
  await writeFile(path.join(repo.config, 'automations.yaml'), '- alias: commit3\n');
  git(repo.config, 'add', 'automations.yaml');
  git(repo.config, 'commit', '-m', 'commit 3');
  const head3 = git(repo.config, 'rev-parse', 'HEAD');
  await server.post('/cloud-sync/push', { force: true });

  assert.equal(git(repo.originRemote, 'rev-parse', 'main'), head3);
  assert.equal(git(repo.mirrorRemote, 'rev-parse', 'main'), head3, 'mirror remote should update to commit 3 once toggle is re-enabled');
});



