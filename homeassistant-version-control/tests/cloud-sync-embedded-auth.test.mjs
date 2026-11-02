// Regression test for Issue #57: Automatic push and test connection must support
// HTTP/HTTPS Git remote URLs with embedded credentials (e.g., Gitea, Forgejo, GitLab, self-hosted)
// by extracting the credentials and configuring http.<url>.extraHeader without leaking them in origin URL.
//
// Run: node --test tests/cloud-sync-embedded-auth.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, exec } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.js');

let sandbox;

before(async () => {
  sandbox = await mkdtemp(path.join(tmpdir(), 'havc-auth-test-'));
});

after(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

function freePort() {
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

function runCmd(cmd, cwd, env = {}) {
  return new Promise((resolve, reject) => {
    exec(cmd, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env } }, (err, stdout, stderr) => {
      if (err) {
        const error = new Error(`Command "${cmd}" failed: ${stderr || err.message}`);
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else {
        resolve(stdout.toString());
      }
    });
  });
}

/**
 * Creates an authenticated Git HTTP smart server using git-http-backend
 */
async function createAuthenticatedGitServer(rootDir, expectedAuth) {
  const bareRepoDir = path.join(rootDir, 'remote.git');
  await runCmd(`git init --bare "${bareRepoDir}"`, rootDir);
  await runCmd(`git --git-dir="${bareRepoDir}" config http.receivepack true`, rootDir);

  const gitExecPath = (await runCmd('git --exec-path', rootDir)).trim();
  const backendBin = path.join(gitExecPath, 'git-http-backend');

  const server = http.createServer((req, res) => {
    const authHeader = req.headers['authorization'];
    if (authHeader !== expectedAuth) {
      res.writeHead(401, {
        'WWW-Authenticate': 'Basic realm="Git Authentication Required"',
        'Content-Type': 'text/plain'
      });
      res.end('Authentication Required');
      return;
    }

    const env = {
      ...process.env,
      GIT_PROJECT_ROOT: rootDir,
      GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: req.url.split('?')[0],
      QUERY_STRING: req.url.split('?')[1] || '',
      REQUEST_METHOD: req.method,
      CONTENT_TYPE: req.headers['content-type'] || '',
    };

    const proc = spawn(backendBin, [], { env });
    req.pipe(proc.stdin);

    let headerBuf = Buffer.alloc(0);
    let headersSent = false;

    proc.stdout.on('data', chunk => {
      if (headersSent) {
        res.write(chunk);
        return;
      }
      headerBuf = Buffer.concat([headerBuf, chunk]);
      const splitIdx = headerBuf.indexOf('\r\n\r\n');
      if (splitIdx !== -1) {
        headersSent = true;
        const headerStr = headerBuf.slice(0, splitIdx).toString('utf-8');
        const body = headerBuf.slice(splitIdx + 4);
        const headers = {};
        let statusCode = 200;
        for (const line of headerStr.split('\r\n')) {
          const idx = line.indexOf(':');
          if (idx > 0) {
            const k = line.slice(0, idx).trim().toLowerCase();
            const v = line.slice(idx + 1).trim();
            if (k === 'status') {
              statusCode = parseInt(v.split(' ')[0], 10);
            } else {
              headers[k] = v;
            }
          }
        }
        res.writeHead(statusCode, headers);
        if (body.length > 0) res.write(body);
      }
    });

    proc.stdout.on('end', () => res.end());
    proc.on('error', () => {
      if (!res.headersSent) res.writeHead(500).end();
    });
  });

  const port = await freePort();
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));

  return {
    port,
    server,
    bareRepoDir,
    close: () => new Promise(resolve => server.close(resolve))
  };
}

test('Cloud Sync extracts embedded username:password in remoteUrl, configures extraHeader, and pushes successfully', async (t) => {
  const root = path.join(sandbox, 'user-pass-test');
  const serverDir = path.join(root, 'server');
  const configDir = path.join(root, 'config');
  const dataDir = path.join(root, 'data');
  const homeDir = path.join(root, 'home');
  await mkdir(serverDir, { recursive: true });
  await mkdir(configDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(path.join(configDir, '.storage'), { recursive: true });

  await writeFile(path.join(configDir, 'configuration.yaml'), 'homeassistant:\n  name: Test\n');
  await writeFile(path.join(configDir, 'automations.yaml'), '[]\n');
  await writeFile(path.join(configDir, '.storage', 'core.entity_registry'), '{}\n');

  const USERNAME = 'gitea_user';
  const PASSWORD = 'secret_password_123';
  const expectedAuth = 'Basic ' + Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64');

  const gitServer = await createAuthenticatedGitServer(serverDir, expectedAuth);
  t.after(async () => {
    await gitServer.close();
  });

  const appPort = await freePort();
  const child = spawn(process.execPath, [SERVER_JS], {
    cwd: path.dirname(SERVER_JS),
    env: {
      ...process.env,
      PORT: String(appPort),
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
  child.stdout.on('data', d => { logs += d.toString(); });
  child.stderr.on('data', d => { logs += d.toString(); });

  const base = `http://127.0.0.1:${appPort}/api`;
  const deadline = Date.now() + 15000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) {
        const data = await res.json();
        if (data.gitInitialized) {
          ready = true;
          break;
        }
      }
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  assert.ok(ready, `Server failed to start:\n${logs}`);

  // URL containing embedded credentials, no separate authToken
  const remoteUrlWithCreds = `http://${USERNAME}:${PASSWORD}@127.0.0.1:${gitServer.port}/remote.git`;
  const cleanRemoteUrl = `http://127.0.0.1:${gitServer.port}/remote.git`;

  // 1. Configure Cloud Sync with embedded credentials and no authToken
  const settingsRes = await fetch(`${base}/cloud-sync/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      enabled: true,
      remoteUrl: remoteUrlWithCreds,
      authProvider: 'generic',
      pushFrequency: 'manual'
    }),
  });
  assert.equal(settingsRes.status, 200);
  const settingsData = await settingsRes.json();
  assert.ok(settingsData.success);

  // 2. Verify git remote origin URL is clean (credentials stripped from remote URL)
  const configuredOrigin = (await runCmd('git remote get-url origin', configDir)).trim();
  assert.equal(configuredOrigin, cleanRemoteUrl, 'Origin remote should have credentials stripped');

  // 3. Verify git extraHeader is configured
  const extraHeaders = (await runCmd('git config --get-regexp "^http\\..*\\.extraheader$"', configDir)).trim();
  assert.ok(extraHeaders.includes(expectedAuth), `extraHeader should contain Authorization: ${expectedAuth}`);

  // 4. Test connection via API
  const testRes = await fetch(`${base}/cloud-sync/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      remoteUrl: remoteUrlWithCreds
    })
  });
  assert.equal(testRes.status, 200);
  const testData = await testRes.json();
  assert.ok(testData.success, `Test connection failed: ${testData.error}`);

  // 5. Test push via API
  const pushRes = await fetch(`${base}/cloud-sync/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ force: true })
  });
  assert.equal(pushRes.status, 200);
  const pushData = await pushRes.json();
  assert.ok(pushData.success, `Push failed: ${pushData.error}`);

  // 6. Verify the bare git remote actually received the push
  const remoteBranches = (await runCmd('git branch', gitServer.bareRepoDir)).trim();
  assert.ok(remoteBranches.includes('main'), 'Remote repository should have received the main branch');
});

test('Cloud Sync extracts embedded personal access token in remoteUrl and configures Authorization: Basic <token:>', async (t) => {
  const root = path.join(sandbox, 'token-test');
  const serverDir = path.join(root, 'server');
  const configDir = path.join(root, 'config');
  const dataDir = path.join(root, 'data');
  const homeDir = path.join(root, 'home');
  await mkdir(serverDir, { recursive: true });
  await mkdir(configDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(path.join(configDir, '.storage'), { recursive: true });

  await writeFile(path.join(configDir, 'configuration.yaml'), 'homeassistant:\n  name: Test\n');
  await writeFile(path.join(configDir, 'automations.yaml'), '[]\n');
  await writeFile(path.join(configDir, '.storage', 'core.entity_registry'), '{}\n');

  const TOKEN = 'forgejo_pat_998877665544';
  const expectedAuth = 'Basic ' + Buffer.from(`${TOKEN}:`).toString('base64');

  const gitServer = await createAuthenticatedGitServer(serverDir, expectedAuth);
  t.after(async () => {
    await gitServer.close();
  });

  const appPort = await freePort();
  const child = spawn(process.execPath, [SERVER_JS], {
    cwd: path.dirname(SERVER_JS),
    env: {
      ...process.env,
      PORT: String(appPort),
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
  child.stdout.on('data', d => { logs += d.toString(); });
  child.stderr.on('data', d => { logs += d.toString(); });

  const base = `http://127.0.0.1:${appPort}/api`;
  const deadline = Date.now() + 15000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) {
        const data = await res.json();
        if (data.gitInitialized) {
          ready = true;
          break;
        }
      }
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  assert.ok(ready, `Server failed to start:\n${logs}`);

  // URL containing bare token
  const remoteUrlWithToken = `http://${TOKEN}@127.0.0.1:${gitServer.port}/remote.git`;
  const cleanRemoteUrl = `http://127.0.0.1:${gitServer.port}/remote.git`;

  const settingsRes = await fetch(`${base}/cloud-sync/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      enabled: true,
      remoteUrl: remoteUrlWithToken,
      authProvider: 'generic',
      pushFrequency: 'manual'
    }),
  });
  assert.equal(settingsRes.status, 200);

  const configuredOrigin = (await runCmd('git remote get-url origin', configDir)).trim();
  assert.equal(configuredOrigin, cleanRemoteUrl, 'Origin remote should have credentials stripped');

  const extraHeaders = (await runCmd('git config --get-regexp "^http\\..*\\.extraheader$"', configDir)).trim();
  assert.ok(extraHeaders.includes(expectedAuth), `extraHeader should contain Authorization: ${expectedAuth}`);

  const pushRes = await fetch(`${base}/cloud-sync/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ force: true })
  });
  assert.equal(pushRes.status, 200);
  const pushData = await pushRes.json();
  assert.ok(pushData.success, `Push failed: ${pushData.error}`);
});

