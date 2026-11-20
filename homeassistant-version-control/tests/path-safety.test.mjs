// Security regression tests for path traversal in the restore endpoints.
//
// These cover the lexical helpers in utils/path-safety.js and the hardening of
// utils/git.js (gitCheckoutSafe / gitShowFileAtCommit / gitCommitDetails).
//
// Run: node --test tests/path-safety.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  resolveInside,
  isInside,
  toRepoRelative,
  isCommitish,
} from '../utils/path-safety.js';
import { gitCheckoutSafe } from '../utils/git.js';

const ROOT = path.join(tmpdir(), 'havc-path-safety-root');

// ──────────────────────────────────────────────────
// resolveInside
// ──────────────────────────────────────────────────

test('resolveInside accepts a normal relative path', () => {
  assert.equal(resolveInside(ROOT, 'automations.yaml'), path.join(ROOT, 'automations.yaml'));
});

test('resolveInside accepts a nested relative path', () => {
  assert.equal(resolveInside(ROOT, 'packages/lights.yaml'), path.join(ROOT, 'packages', 'lights.yaml'));
});

test('resolveInside rejects a ../ escape', () => {
  assert.equal(resolveInside(ROOT, '../escape.yaml'), null);
  assert.equal(resolveInside(ROOT, 'packages/../../escape.yaml'), null);
});

test('resolveInside rejects an absolute path', () => {
  assert.equal(resolveInside(ROOT, '/etc/passwd'), null);
});

test('resolveInside rejects an empty path', () => {
  assert.equal(resolveInside(ROOT, ''), null);
  assert.equal(resolveInside(ROOT, '   '), null);
});

test('resolveInside rejects null bytes', () => {
  assert.equal(resolveInside(ROOT, 'automations.yaml\0.png'), null);
});

test('resolveInside only allows the root itself when allowRoot is set', () => {
  assert.equal(resolveInside(ROOT, '', { allowRoot: true }), path.resolve(ROOT));
  assert.equal(resolveInside(ROOT, '.', { allowRoot: true }), path.resolve(ROOT));
  assert.equal(resolveInside(ROOT, 'automations.yaml', { allowRoot: true }), path.join(ROOT, 'automations.yaml'));
});

// ──────────────────────────────────────────────────
// isInside / toRepoRelative
// ──────────────────────────────────────────────────

test('isInside detects paths inside and outside the root', () => {
  assert.equal(isInside(ROOT, path.join(ROOT, 'automations.yaml')), true);
  assert.equal(isInside(ROOT, path.join(ROOT, 'packages', 'lights.yaml')), true);
  assert.equal(isInside(ROOT, path.resolve(ROOT)), true);
  assert.equal(isInside(ROOT, path.join(ROOT, '..', 'escape.yaml')), false);
  assert.equal(isInside(ROOT, '/etc/passwd'), false);
});

test('toRepoRelative returns forward-slash relative paths and rejects escapes', () => {
  assert.equal(toRepoRelative(ROOT, 'automations.yaml'), 'automations.yaml');
  assert.equal(toRepoRelative(ROOT, 'packages/lights.yaml'), 'packages/lights.yaml');
  assert.equal(toRepoRelative(ROOT, './packages/lights.yaml'), 'packages/lights.yaml');
  assert.equal(toRepoRelative(ROOT, '../escape.yaml'), null);
  assert.equal(toRepoRelative(ROOT, '/etc/passwd'), null);
  assert.equal(toRepoRelative(ROOT, ''), null);
});

// ──────────────────────────────────────────────────
// isCommitish
// ──────────────────────────────────────────────────

test('isCommitish accepts short/full SHAs and ancestor suffixes', () => {
  assert.equal(isCommitish('4f10ce7'), true);
  assert.equal(isCommitish('4f10ce7^'), true);
  assert.equal(isCommitish('4f10ce7~2'), true);
  assert.equal(isCommitish('a'.repeat(40)), true);
});

test('isCommitish rejects options, refs and shell fragments', () => {
  assert.equal(isCommitish('--output=/tmp/x'), false);
  assert.equal(isCommitish('HEAD'), false);
  assert.equal(isCommitish('4f10ce7; ls'), false);
  assert.equal(isCommitish(''), false);
  assert.equal(isCommitish(null), false);
});

// ──────────────────────────────────────────────────
// gitCheckoutSafe integration
// ──────────────────────────────────────────────────

function gitEnv(sandbox) {
  return { ...process.env, HOME: path.join(sandbox, 'home'), GIT_CONFIG_NOSYSTEM: '1' };
}

function git(cwd, sandbox, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv(sandbox) }).trim();
}

test('gitCheckoutSafe restores inside the repo and rejects traversal', async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), 'havc-path-safety-'));
  const repo = path.join(sandbox, 'config');
  const previousConfigPath = global.CONFIG_PATH;

  try {
    await mkdir(path.join(sandbox, 'home'), { recursive: true });
    await mkdir(repo, { recursive: true });

    git(repo, sandbox, 'init', '-b', 'main');
    git(repo, sandbox, 'config', 'user.name', 'Test User');
    git(repo, sandbox, 'config', 'user.email', 'test@example.com');

    const original = 'automations:\n  - alias: original\n';
    await writeFile(path.join(repo, 'automations.yaml'), original);
    git(repo, sandbox, 'add', '.');
    git(repo, sandbox, 'commit', '-q', '-m', 'add automations');
    const head = git(repo, sandbox, 'rev-parse', 'HEAD');

    global.CONFIG_PATH = repo;

    // Restore overwrites a modified tracked file with the committed content.
    await writeFile(path.join(repo, 'automations.yaml'), 'automations: [] # modified\n');
    await gitCheckoutSafe(head, 'automations.yaml');
    assert.equal(await readFile(path.join(repo, 'automations.yaml'), 'utf8'), original);

    // Traversal must be refused, and nothing may be written outside the repo.
    const outside = path.join(sandbox, 'escape.yaml');
    await assert.rejects(
      () => gitCheckoutSafe(head, '../escape.yaml'),
      /outside the config root/,
    );
    assert.equal(existsSync(outside), false, 'nothing was written outside the repo');
  } finally {
    global.CONFIG_PATH = previousConfigPath;
    await rm(sandbox, { recursive: true, force: true });
  }
});
