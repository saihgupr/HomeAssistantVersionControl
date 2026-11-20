import path from 'node:path';
import { promises as fs } from 'node:fs';

/**
 * Resolve a user-supplied path underneath a fixed root directory.
 *
 * Returns the absolute path when it stays inside the root, or null when the
 * input is missing, contains a null byte, or escapes the root.
 *
 * This is a lexical check. Use realPathInside()/realPathInsideParent() when a
 * symlink could point somewhere else.
 *
 * @param {string} root
 * @param {string} userPath
 * @param {{ allowRoot?: boolean }} [options]
 * @returns {string|null}
 */
export function resolveInside(root, userPath, options = {}) {
  const { allowRoot = false } = options;

  if (typeof root !== 'string' || typeof userPath !== 'string') return null;
  if (root.includes('\0') || userPath.includes('\0')) return null;

  const trimmed = userPath.trim();
  if (!trimmed && !allowRoot) return null;

  const base = path.resolve(root);
  const target = path.resolve(base, trimmed);
  const relative = path.relative(base, target);

  if (relative === '') {
    return allowRoot ? target : null;
  }

  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return null;
  }

  return target;
}

/**
 * True when target is root itself or sits underneath root.
 * Lexical only.
 *
 * @param {string} root
 * @param {string} target
 * @returns {boolean}
 */
export function isInside(root, target) {
  if (typeof root !== 'string' || typeof target !== 'string') return false;
  if (root.includes('\0') || target.includes('\0')) return false;

  const base = path.resolve(root);
  const absolute = path.resolve(target);
  const relative = path.relative(base, absolute);

  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Convert a user-supplied path into a repo-relative path using forward slashes.
 * Returns null when the path is invalid or escapes the root.
 *
 * @param {string} root
 * @param {string} userPath
 * @returns {string|null}
 */
export function toRepoRelative(root, userPath) {
  const resolved = resolveInside(root, userPath);
  if (!resolved) return null;
  const relative = path.relative(path.resolve(root), resolved);
  return relative.split(path.sep).join('/');
}

/**
 * Follow symlinks for an existing path and check that the real target stays
 * inside the real root.
 *
 * @param {string} root
 * @param {string} target
 * @returns {Promise<boolean>}
 */
export async function realPathInside(root, target) {
  try {
    const realRoot = await fs.realpath(root);
    const realTarget = await fs.realpath(target);
    return isInside(realRoot, realTarget);
  } catch {
    return false;
  }
}

/**
 * Follow symlinks for the nearest existing ancestor of a path that may not
 * exist yet. This catches a symlinked directory in the middle of the path
 * before a caller creates files underneath it.
 *
 * @param {string} root
 * @param {string} target
 * @returns {Promise<boolean>}
 */
export async function realPathInsideParent(root, target) {
  try {
    const realRoot = await fs.realpath(root);
    let ancestor = path.dirname(path.resolve(target));

    while (true) {
      try {
        const realAncestor = await fs.realpath(ancestor);
        return isInside(realRoot, realAncestor);
      } catch (error) {
        if (error.code !== 'ENOENT') return false;
        const parent = path.dirname(ancestor);
        if (parent === ancestor) return false;
        ancestor = parent;
      }
    }
  } catch {
    return false;
  }
}

// Short or full SHA, optionally followed by parent/ancestor suffixes, e.g.
// 4f10ce7, 4f10ce7^, 4f10ce7~2, 4f10ce7^^.
const COMMITISH_RE = /^[0-9a-f]{4,64}(?:\^|~\d*)*$/i;

/**
 * True when a value is a plain commit-ish we are willing to pass to git.
 * Rejects anything that could be parsed as a git option, such as
 * --output=/tmp/file.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isCommitish(value) {
  return typeof value === 'string' && COMMITISH_RE.test(value.trim());
}

/**
 * Throw unless the value is a safe commit-ish.
 *
 * @param {unknown} value
 * @param {string} [label]
 * @returns {string}
 */
export function assertCommitish(value, label = 'commit hash') {
  if (!isCommitish(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value.trim();
}
