import express from 'express';
import {
  gitLog,
  gitStatus,
  gitShowFileAtCommit,
  gitCommitDetails,
  gitAdd,
  gitCommit,
  gitRaw,
  getLightweightGitLog,
  gitExec,
  gitInit,
  gitCheckIsRepo,
  gitDiff,
  gitCheckout,
  gitCheckoutSafe,
  gitBranch,
  gitRevparse,
  gitRmCached,
  gitResetHead
} from './utils/git.js';
import chokidar from 'chokidar';
import fs from 'fs';
import { promises as fsPromises } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Paths to public directory (relative to server.js location)
const PUBLIC_DIR = path.join(__dirname, 'public');
import {
  extractAutomations,
  extractScripts,
  getAutomationHistory,
  getScriptHistory,
  getAutomationDiff,
  getScriptDiff,
  restoreAutomation,
  restoreScript,
  getConfigFilePaths,
  getAutomationHistoryMetadata,
  getAutomationAtCommit,
  getScriptHistoryMetadata,
  getScriptAtCommit
} from './automation-parser.js';

// Override console.log and console.error to add timestamps
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

function getTimestamp() {
  return new Date().toISOString();
}

console.log = function (...args) {
  originalConsoleLog(`[${getTimestamp()}]`, ...args);
};

console.error = function (...args) {
  originalConsoleError(`[${getTimestamp()}]`, ...args);
};



const app = express();
const PORT = process.env.PORT || 54001;
const HOST = process.env.HOST || '::';
const EXTERNAL_MIRROR_DIR = '.havc_external';
const ALLOWED_ADDITIONAL_PATH_PREFIXES = ['/share', '/media', '/ssl', '/config'];

// Ensure HOME is set for git
if (!process.env.HOME) {
  process.env.HOME = '/tmp';
  console.log('[init] Set HOME=/tmp for git compatibility');
}

function configureGitIdentity() {
  if (runtimeSettings.manualMode) {
    console.log('[init] Manual mode active: skipping global git configuration');
    return;
  }

  // Configure git at runtime (safe.directory and identity)
  // This must happen AFTER HOME is set, since git config --global writes to $HOME/.gitconfig
  try {
    execSync('git config --global --add safe.directory /config', { stdio: 'pipe' });
    execSync('git config --global --add safe.directory /usr/src/app', { stdio: 'pipe' });

    // Only set default identity if not already configured
    try {
      execSync('git config --global user.email', { stdio: 'pipe' });
    } catch (e) {
      execSync('git config --global user.email "havc@local"', { stdio: 'pipe' });
      console.log('[init] Set default git user.email');
    }

    try {
      execSync('git config --global user.name', { stdio: 'pipe' });
    } catch (e) {
      execSync('git config --global user.name "Home Assistant Version Control"', { stdio: 'pipe' });
      console.log('[init] Set default git user.name');
    }

    execSync('git config --global init.defaultBranch main', { stdio: 'pipe' });
    console.log('[init] Git configured: safe.directory and defaultBranch set');
  } catch (e) {
    console.error('[init] Failed to configure git:', e.message);
  }
}

app.use(express.json());

// CORS middleware for Home Assistant Ingress
app.use((req, res, next) => {
  // Get the origin from the request
  const origin = req.headers.origin;

  // Allow any localhost variation
  if (origin && (origin.includes('localhost') ||
    origin.includes('127.0.0.1') ||
    origin.includes('192.168.') ||
    origin.includes('10.') ||
    origin.includes('172.'))) {
    res.header('Access-Control-Allow-Origin', origin);
  }

  // Allow credentials
  res.header('Access-Control-Allow-Credentials', 'true');

  // Allowed methods and headers
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  next();
});

// Ingress path detection and URL rewriting middleware
app.use((req, res, next) => {
  // Detect ingress path from headers
  const ingressPath = req.headers['x-ingress-path'] ||
    req.headers['x-forwarded-prefix'] ||
    req.headers['x-external-url'] ||
    '';

  // Make ingress path available
  res.locals.ingressPath = ingressPath;

  if (ingressPath) {
    // Strip ingress prefix from URL for routing
    if (req.originalUrl.startsWith(ingressPath)) {
      req.url = req.originalUrl.substring(ingressPath.length) || '/';
    }
  }

  next();
});

// Static files - serve public directory at root
// Add cache control headers for JSON files to prevent stale translations
app.use((req, res, next) => {
  // Set cache headers for JSON files (translations, etc.) but not API endpoints
  if (req.url.endsWith('.json') && !req.url.includes('/api/')) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  }
  next();
});
app.use(express.static(PUBLIC_DIR));

// Root endpoint
app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// Favicon route
app.get('/favicon.ico', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'images', 'favicon.ico'));
});

// Helper function to call Home Assistant services via Supervisor API
async function callHomeAssistantService(domain, service, serviceData = {}) {
  try {
    // Try multiple ways to get the supervisor token
    let supervisorToken = process.env.SUPERVISOR_TOKEN || process.env.HASSIO_TOKEN;

    // If not in env, try reading from the token file
    if (!supervisorToken) {
      try {
        supervisorToken = await fsPromises.readFile('/run/secrets/supervisor_token', 'utf-8');
        supervisorToken = supervisorToken.trim();
      } catch (e) {
        // Token file doesn't exist
      }
    }

    // If still not found, try s6-overlay environment directory (common in HA addons)
    if (!supervisorToken) {
      try {
        supervisorToken = await fsPromises.readFile('/var/run/s6/container_environment/SUPERVISOR_TOKEN', 'utf-8');
        supervisorToken = supervisorToken.trim();
      } catch (e) {
        // s6 env file doesn't exist
      }
    }

    // Try HASSIO_TOKEN from s6 as well
    if (!supervisorToken) {
      try {
        supervisorToken = await fsPromises.readFile('/var/run/s6/container_environment/HASSIO_TOKEN', 'utf-8');
        supervisorToken = supervisorToken.trim();
      } catch (e) {
        // s6 env file doesn't exist
      }
    }

    if (!supervisorToken) {
      console.log('[HA API] SUPERVISOR_TOKEN not available, skipping service call');
      console.log('[HA API] Tried: SUPERVISOR_TOKEN, HASSIO_TOKEN env vars and /run/secrets/supervisor_token file');

      // Debug: Print available environment keys
      console.log('[HA API] Available environment variables:', Object.keys(process.env).join(', '));

      return { success: false, error: 'SUPERVISOR_TOKEN not available' };
    }

    // Determine the API URL based on environment
    // In Docker mode: use HA_URL (e.g., http://homeassistant.local:8123)
    // In addon mode: use supervisor endpoint
    const haUrl = process.env.HA_URL;
    let url;

    if (haUrl) {
      // Docker mode - use provided HA_URL
      const baseUrl = haUrl.replace(/\/$/, ''); // Remove trailing slash if present
      url = `${baseUrl}/api/services/${domain}/${service}`;
      console.log(`[HA API] Using Docker mode with HA_URL: ${haUrl}`);
    } else {
      // Addon mode - use supervisor endpoint
      url = `http://supervisor/core/api/services/${domain}/${service}`;
      console.log(`[HA API] Using addon mode with supervisor endpoint`);
    }

    console.log(`[HA API] Calling service: ${domain}.${service}`);

    // Add timeout to prevent long waits (5 seconds)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${supervisorToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(serviceData),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        console.log(`[HA API] Service ${domain}.${service} called successfully`);
        return { success: true };
      } else {
        const errorText = await response.text();
        console.error(`[HA API] Service call failed: ${response.status} ${errorText}`);
        return { success: false, error: `HTTP ${response.status}: ${errorText}` };
      }
    } catch (fetchError) {
      clearTimeout(timeoutId);
      if (fetchError.name === 'AbortError') {
        console.error(`[HA API] Request timeout after 5 seconds`);
        return { success: false, error: 'Request timeout - check HA_URL is correct and Home Assistant is reachable' };
      }
      throw fetchError;
    }
  } catch (error) {
    console.error(`[HA API] Error calling service ${domain}.${service}:`, error.message);
    return { success: false, error: error.message };
  }
}

// Restart Home Assistant endpoint
app.post('/api/ha/restart', async (req, res) => {
  try {
    console.log('[HA API] Requesting Home Assistant restart...');
    const result = await callHomeAssistantService('homeassistant', 'restart');
    if (result.success) {
      res.json({ success: true, message: 'Home Assistant is restarting' });
    } else {
      res.status(500).json({ success: false, error: result.error });
    }
  } catch (error) {
    console.error('[HA API] Error restarting Home Assistant:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});


// Error handler
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ error: err.message });
});

// Global process handlers for diagnostics
process.on('uncaughtException', (err) => {
  console.error('!!!! UNCAUGHT EXCEPTION !!!!');
  console.error(err);
  // Don't exit immediately, let the container manager handle it or try to recover
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('!!!! UNHANDLED REJECTION !!!!');
  console.error('Reason:', reason);
});

process.on('SIGTERM', () => {
  console.log('[system] Received SIGTERM signal - shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[system] Received SIGINT signal - shutting down...');
  process.exit(0);
});

// CONFIG_PATH will be determined at runtime
let CONFIG_PATH = null;
global.CONFIG_PATH = null;
let gitInitialized = false;
let additionalTrackedPaths = [];
let configOptions = {
  yaml_format: true,
  json_format: false,
  py_format: false,
  txt_format: false,
  invisible_files: true
};

// Runtime settings loaded from file
let runtimeSettings = {
  debounceTime: 3,
  debounceTimeUnit: 'seconds',
  historyRetention: false,
  retentionType: 'age', // 'count' or 'age'
  retentionValue: 30,
  retentionUnit: 'days', // for time type
  limitHistory: false,
  maxCommits: 500,
  // Cloud Sync Settings

  cloudSync: {
    enabled: false,
    remoteUrl: '', // Current active URL (set based on authProvider)
    githubRemoteUrl: '', // Stored GitHub URL (preserved when switching)
    customRemoteUrl: '', // Stored Custom URL (preserved when switching)
    authProvider: '', // 'github' or 'generic'
    authToken: '', // OAuth token or PAT
    pushFrequency: 'manual', // 'manual', 'every_commit', 'hourly', 'daily'
    includeSecrets: false, // Default to FALSE (exclude by default)
    ignoreSslErrors: false, // Whether to ignore SSL certificate validation errors
    lastPushTime: null,
    lastPushStatus: null, // 'success', 'failed'
    lastPushError: null
  },
  // File extension configuration - what gets tracked/ignored
  extensions: {
    include: ['yaml', 'yml'], // File extensions to track
    exclude: ['secrets.yaml'], // Specific files to ignore (always ignored regardless of extension)
    excludeFolders: [], // Entire folders to ignore
    storage: ['lovelace', 'lovelace_dashboards', 'lovelace_resources', 'lovelace.*'] // Files in .storage to track
  },
  additionalPaths: [],
  manualMode: false,
  watcherUsePolling: true,
  watcherInterval: 2000
};

// Schema for runtime settings with validation rules and environment variable mapping
const RUNTIME_SETTINGS_SCHEMA = {
  debounceTime: {
    type: 'number',
    min: 0,
    envKey: 'DEBOUNCE_TIME'
  },
  debounceTimeUnit: {
    type: 'enum',
    values: ['seconds', 'minutes', 'hours', 'days'],
    envKey: 'DEBOUNCE_TIME_UNIT'
  },
  watcherUsePolling: {
    type: 'boolean',
    envKey: 'WATCHER_USE_POLLING'
  },
  watcherInterval: {
    type: 'number',
    min: 100,
    envKey: 'WATCHER_INTERVAL'
  },
  historyRetention: {
    type: 'boolean',
    envKey: 'HISTORY_RETENTION'
  },
  retentionType: {
    type: 'enum',
    values: ['time', 'age', 'versions', 'count'],
    envKey: 'RETENTION_TYPE'
  },
  retentionValue: {
    type: 'number',
    min: 1,
    envKey: 'RETENTION_VALUE'
  },
  retentionUnit: {
    type: 'enum',
    values: ['hours', 'days', 'weeks', 'months'],
    envKey: 'RETENTION_UNIT'
  },
  limitHistory: {
    type: 'boolean',
    envKey: 'LIMIT_HISTORY'
  },
  maxCommits: {
    type: 'number',
    min: 50,
    max: 10000,
    envKey: 'MAX_COMMITS'
  },
  manualMode: {
    type: 'boolean',
    envKey: 'MANUAL_MODE'
  },
  includeExtensions: {
    type: 'list',
    envKey: 'INCLUDE_EXTENSIONS'
  },
  excludeFiles: {
    type: 'list',
    envKey: 'EXCLUDE_FILES'
  },
  excludeFolders: {
    type: 'list',
    envKey: 'EXCLUDE_FOLDERS'
  },
  includeStorage: {
    type: 'list',
    envKey: 'INCLUDE_STORAGE'
  },
  additionalPaths: {
    type: 'list',
    envKey: 'ADDITIONAL_PATHS'
  }
};

/**
 * Parse and validate an environment variable value based on schema
 */
function parseEnvVarValue(key, schema, rawValue) {
  const trimmed = rawValue.trim();
  if (trimmed === '') return { valid: false, error: 'Empty value' };

  switch (schema.type) {
    case 'number': {
      const parsed = parseInt(trimmed, 10);
      if (isNaN(parsed) || trimmed !== String(parsed)) return { valid: false, error: `Expected integer, got: '${rawValue}'` };
      if (schema.min !== undefined && parsed < schema.min) return { valid: false, error: `Expected >= ${schema.min}, got: ${parsed}` };
      return { valid: true, value: parsed };
    }
    case 'boolean': {
      const normalized = trimmed.toLowerCase();
      if (['true', '1', 'yes'].includes(normalized)) return { valid: true, value: true };
      if (['false', '0', 'no'].includes(normalized)) return { valid: true, value: false };
      return { valid: false, error: `Expected boolean, got: '${rawValue}'` };
    }
    case 'enum': {
      const normalized = trimmed.toLowerCase();
      // Special handling for legacy vs new retention names
      if (key === 'retentionType') {
        if (normalized === 'versions' || normalized === 'count') return { valid: true, value: 'count' };
        if (normalized === 'time' || normalized === 'age') return { valid: true, value: 'age' };
      }
      const match = schema.values.find(v => v.toLowerCase() === normalized);
      if (match) return { valid: true, value: match };
      return { valid: false, error: `Expected one of [${schema.values.join(', ')}], got: '${rawValue}'` };
    }
    case 'list': {
      const items = trimmed.split(',')
        .map(item => item.trim())
        .filter(item => item.length > 0);
      return { valid: true, value: items };
    }
    default:
      return { valid: false, error: `Unknown type: ${schema.type}` };
  }
}

/**
 * Load runtime settings from environment variables
 */
function loadSettingsFromEnv() {
  const settings = {};
  const sources = {};
  for (const [key, schema] of Object.entries(RUNTIME_SETTINGS_SCHEMA)) {
    const envValue = process.env[schema.envKey];
    if (envValue === undefined) continue;
    const result = parseEnvVarValue(key, schema, envValue);
    if (result.valid) {
      settings[key] = result.value;
      sources[key] = `env: ${schema.envKey}`;
    } else {
      console.log(`[init] Warning: Invalid ${schema.envKey}='${envValue}', ${result.error}.`);
    }
  }
  return { settings, sources };
}

// Global lock for cleanup operations
let cleanupLock = false;

// Helper function to ensure git is initialized
function ensureGitInitialized() {
  if (!gitInitialized) {
    throw new Error('Git repository not initialized yet. Please try again in a moment.');
  }
}

/**
 * Get configured file extensions based on addon config
 * @returns {Array<string>} Array of extensions like ['.yaml', '.yml']
 */
function getConfiguredExtensions() {
  const include = runtimeSettings?.extensions?.include;
  if (Array.isArray(include) && include.length > 0) {
    return [...new Set(
      include
        .map(ext => String(ext || '').trim().toLowerCase().replace(/^\./, ''))
        .filter(Boolean)
        .map(ext => `.${ext}`)
    )];
  }

  const fallback = [];
  if (configOptions.yaml_format) fallback.push('.yaml', '.yml');
  if (configOptions.json_format) fallback.push('.json');
  if (configOptions.py_format) fallback.push('.py');
  if (configOptions.txt_format) fallback.push('.txt');
  return [...new Set(fallback)];
}

function getConfiguredStoragePatterns() {
  const storage = runtimeSettings?.extensions?.storage;
  const defaults = ['lovelace', 'lovelace_dashboards', 'lovelace_resources', 'lovelace.*'];
  const selected = Array.isArray(storage) && storage.length > 0 ? storage : defaults;

  return [...new Set(
    selected
      .map(pattern => String(pattern || '').trim())
      .filter(Boolean)
      .map(pattern => pattern.replace(/^\.storage\//, '').replace(/^\/+/, ''))
      .filter(Boolean)
  )];
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesGlobPattern(value, pattern) {
  const regexStr = `^${escapeRegex(pattern).replace(/\\\*/g, '.*').replace(/\\\?/g, '.')}$`;
  return new RegExp(regexStr).test(value);
}

function isConfiguredStorageRepoPath(repoPath) {
  const normalized = normalizeRepoRelativePath(repoPath);
  if (!normalized || !normalized.startsWith('.storage/')) {
    return false;
  }

  const storageRelPath = normalized.slice('.storage/'.length);
  const patterns = getConfiguredStoragePatterns();
  return patterns.some(pattern => matchesGlobPattern(storageRelPath, pattern));
}

function isConfiguredStorageAbsolutePath(absolutePath) {
  const normalized = normalizeAbsolutePath(absolutePath);
  if (!normalized || !CONFIG_PATH || !isPathUnder(CONFIG_PATH, normalized)) {
    return false;
  }

  const repoPath = absolutePathToRepoPath(normalized);
  return isConfiguredStorageRepoPath(repoPath);
}

function normalizeAbsolutePath(inputPath) {
  if (typeof inputPath !== 'string') return null;
  const trimmed = inputPath.trim();
  if (!trimmed.startsWith('/')) return null;
  const normalized = path.posix.normalize(trimmed);
  if (!normalized.startsWith('/')) return null;
  return normalized;
}

function normalizeRepoRelativePath(repoPath) {
  if (typeof repoPath !== 'string') return null;
  const normalized = path.posix.normalize(repoPath.trim().replace(/\\/g, '/')).replace(/^\/+/, '');
  if (!normalized || normalized === '.' || normalized.startsWith('..')) return null;
  return normalized;
}

function isPathUnder(basePath, targetPath) {
  const base = normalizeAbsolutePath(basePath);
  const target = normalizeAbsolutePath(targetPath);
  if (!base || !target) return false;
  return target === base || target.startsWith(`${base}/`);
}

function sanitizeAdditionalPaths(paths) {
  if (!Array.isArray(paths)) return [];

  const normalized = [];
  for (const rawPath of paths) {
    const candidate = normalizeAbsolutePath(String(rawPath || '').replace(/\/+$/, ''));
    if (!candidate || candidate === '/') continue;

    const allowedPrefix = ALLOWED_ADDITIONAL_PATH_PREFIXES.find(prefix => isPathUnder(prefix, candidate));
    if (!allowedPrefix) {
      console.log(`[external-sync] Skipping unsupported additional path: ${rawPath}`);
      continue;
    }

    // /config is already tracked as the main repository root.
    if (CONFIG_PATH && isPathUnder(CONFIG_PATH, candidate)) {
      console.log(`[external-sync] Skipping additional path already under CONFIG_PATH: ${candidate}`);
      continue;
    }

    if (!normalized.includes(candidate)) {
      normalized.push(candidate);
    }
  }

  return normalized;
}

function isMirroredExternalRepoPath(repoPath) {
  const normalized = normalizeRepoRelativePath(repoPath);
  if (!normalized) return false;
  return normalized.startsWith(`${EXTERNAL_MIRROR_DIR}/`);
}

function repoPathToExternalAbsolute(repoPath) {
  const normalized = normalizeRepoRelativePath(repoPath);
  if (!normalized || !isMirroredExternalRepoPath(normalized)) return null;

  const withoutPrefix = normalized.slice(EXTERNAL_MIRROR_DIR.length + 1);
  if (!withoutPrefix) return null;
  return normalizeAbsolutePath(`/${withoutPrefix}`);
}

function externalAbsoluteToMirrorAbsolute(externalAbsolutePath) {
  const normalized = normalizeAbsolutePath(externalAbsolutePath);
  if (!normalized || !CONFIG_PATH) return null;
  const relativeFromRoot = normalized.replace(/^\/+/, '');
  return path.join(CONFIG_PATH, EXTERNAL_MIRROR_DIR, ...relativeFromRoot.split('/'));
}

function absolutePathToRepoPath(absolutePath) {
  if (!CONFIG_PATH) return null;
  const relative = path.relative(CONFIG_PATH, absolutePath).replace(/\\/g, '/');
  if (!relative || relative.startsWith('..')) return null;
  return relative;
}

function isFileTrackableForSync(absolutePath) {
  const normalized = normalizeAbsolutePath(absolutePath);
  if (!normalized) return false;
  if (path.posix.basename(normalized).startsWith('._')) return false;

  const lowerPath = normalized.toLowerCase();
  const extensions = getConfiguredExtensions();
  return extensions.some(ext => lowerPath.endsWith(ext));
}

function isPathInConfiguredAdditionalPaths(absolutePath) {
  return additionalTrackedPaths.some(basePath => isPathUnder(basePath, absolutePath));
}

async function removeMirrorFileForExternalPath(externalPath) {
  const mirrorAbsolute = externalAbsoluteToMirrorAbsolute(externalPath);
  if (!mirrorAbsolute) return null;
  await fsPromises.rm(mirrorAbsolute, { force: true });
  await pruneEmptyMirrorDirectories(path.dirname(mirrorAbsolute));
  return absolutePathToRepoPath(mirrorAbsolute);
}

async function syncExternalFileToMirror(externalPath) {
  const normalized = normalizeAbsolutePath(externalPath);
  if (!normalized || !isPathInConfiguredAdditionalPaths(normalized)) return null;

  const mirrorAbsolute = externalAbsoluteToMirrorAbsolute(normalized);
  if (!mirrorAbsolute) return null;

  if (!isFileTrackableForSync(normalized)) {
    return removeMirrorFileForExternalPath(normalized);
  }

  await fsPromises.mkdir(path.dirname(mirrorAbsolute), { recursive: true });
  await fsPromises.copyFile(normalized, mirrorAbsolute);
  return absolutePathToRepoPath(mirrorAbsolute);
}

async function walkFilesRecursive(dirPath, onFile) {
  let entries = [];
  try {
    entries = await fsPromises.readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error(`[external-sync] Failed reading directory ${dirPath}:`, error.message);
    }
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);

    if (entry.isSymbolicLink()) {
      continue;
    }

    if (entry.isDirectory()) {
      if (entry.name === '.git' || entry.name === 'node_modules') {
        continue;
      }
      await walkFilesRecursive(fullPath, onFile);
      continue;
    }

    if (entry.isFile()) {
      await onFile(fullPath);
    }
  }
}

async function pruneEmptyMirrorDirectories(startDir) {
  const mirrorRoot = path.join(CONFIG_PATH, EXTERNAL_MIRROR_DIR);
  let current = startDir;

  while (current.startsWith(mirrorRoot)) {
    let entries;
    try {
      entries = await fsPromises.readdir(current);
    } catch (error) {
      break;
    }

    if (entries.length > 0) {
      break;
    }

    await fsPromises.rmdir(current);
    if (current === mirrorRoot) {
      break;
    }
    current = path.dirname(current);
  }
}

async function syncSingleAdditionalPathToMirror(additionalPath) {
  try {
    await fsPromises.access(additionalPath, fs.constants.R_OK);
  } catch (error) {
    console.log(`[external-sync] Path not readable, skipping sync: ${additionalPath} (${error.code || 'ERROR'}: ${error.message})`);

    // Help the user debug ENOENT for /media or /share paths
    if (error.code === 'ENOENT' && (additionalPath.startsWith('/media') || additionalPath.startsWith('/share'))) {
      const parentDir = path.dirname(additionalPath);
      console.log(`[smart-diagnostics] ${additionalPath} is missing. Auditing environment...`);
      try {
        const rootDirs = await fsPromises.readdir('/');
        console.log(`[smart-diagnostics] Root directories (/):`, rootDirs);

        for (const dir of ['/media', '/share', '/config']) {
          try {
            const contents = await fsPromises.readdir(dir);
            console.log(`[smart-diagnostics] Contents of ${dir}:`, contents);
          } catch (e) {
            console.log(`[smart-diagnostics] Could not read ${dir}:`, e.message);
          }
        }
        console.log(`[smart-diagnostics] Tip: If your files are on a Mac at '/Volumes/media-1', you must first mount that drive into Home Assistant's 'Media' folder in the HA System Settings.`);
      } catch (diagErr) {
        console.log(`[smart-diagnostics] Audit failed:`, diagErr.message);
      }
    }
    return { copied: 0, removed: 0 };
  }

  const mirrorRootForPath = externalAbsoluteToMirrorAbsolute(additionalPath);
  if (!mirrorRootForPath) return { copied: 0, removed: 0 };

  const desiredRepoPaths = new Set();
  let copied = 0;

  const foundFiles = [];
  await walkFilesRecursive(additionalPath, async (absoluteFilePath) => {
    const normalized = normalizeAbsolutePath(absoluteFilePath);
    if (!normalized) return;

    if (!isFileTrackableForSync(normalized)) return;

    foundFiles.push(normalized);
    const repoPath = await syncExternalFileToMirror(normalized);
    if (repoPath) {
      desiredRepoPaths.add(repoPath);
      copied += 1;
    }
  });

  if (foundFiles.length > 0) {
    console.log(`[external-sync] Found ${foundFiles.length} files in ${additionalPath}:`);
    for (const f of foundFiles) {
      const mirrorPath = externalAbsoluteToMirrorAbsolute(f);
      const repoPath = absolutePathToRepoPath(mirrorPath);
      console.log(`[external-sync]   - ${f} -> ${repoPath}`);
    }
  } else {
    console.log(`[external-sync] No trackable files found in ${additionalPath}`);
  }

  let removed = 0;
  await walkFilesRecursive(mirrorRootForPath, async (mirrorFilePath) => {
    const repoPath = absolutePathToRepoPath(mirrorFilePath);
    if (!repoPath) return;

    if (!desiredRepoPaths.has(repoPath)) {
      await fsPromises.rm(mirrorFilePath, { force: true });
      removed += 1;
    }
  });
  await pruneEmptyMirrorDirectories(mirrorRootForPath);

  return { copied, removed };
}

async function syncAllAdditionalPathsToMirror() {
  if (!additionalTrackedPaths.length) {
    if (CONFIG_PATH) {
      await fsPromises.rm(path.join(CONFIG_PATH, EXTERNAL_MIRROR_DIR), { recursive: true, force: true });
    }
    return { copied: 0, removed: 0, paths: 0 };
  }

  let copied = 0;
  let removed = 0;
  for (const additionalPath of additionalTrackedPaths) {
    const stats = await syncSingleAdditionalPathToMirror(additionalPath);
    copied += stats.copied;
    removed += stats.removed;
  }
  return { copied, removed, paths: additionalTrackedPaths.length };
}

async function writeFileFromCommitToExternalPath(commitHash, repoPath) {
  const externalPath = repoPathToExternalAbsolute(repoPath);
  if (!externalPath) {
    throw new Error(`Invalid mirrored external path: ${repoPath}`);
  }
  if (!isPathInConfiguredAdditionalPaths(externalPath)) {
    throw new Error(`External path is not currently configured for tracking: ${externalPath}`);
  }

  const content = await gitShowFileAtCommit(commitHash, repoPath);
  await fsPromises.mkdir(path.dirname(externalPath), { recursive: true });
  await fsPromises.writeFile(externalPath, content, 'utf8');
}

async function restorePathToCommit(commitHash, repoPath) {
  if (isMirroredExternalRepoPath(repoPath)) {
    await writeFileFromCommitToExternalPath(commitHash, repoPath);
    return;
  }
  await gitCheckoutSafe(commitHash, repoPath);
}

/**
 * Generate .gitignore content based on configured extensions
 * @returns {string} .gitignore file content
 */
const IGNORED_NESTED_REPOS = [];

/**
 * Generate .gitignore contents with managed section
 * @param {Array<string>} extraIgnores - Additional paths to ignore (nested repos)
 * @param {Object} extensions - Extensions config with include/exclude arrays
 * @returns {string} .gitignore file content
 */
function generateGitignoreContent(extraIgnores = [], extensions = null) {
  const MANAGED_START = '# === Home Assistant Version Control Managed (do not edit below) ===';
  const MANAGED_END = '# === End Home Assistant Version Control Managed ===';

  // Use provided extensions or defaults
  const ext = extensions || runtimeSettings.extensions || { include: ['yaml', 'yml'], exclude: ['secrets.yaml'] };
  const includeExts = ext.include || ['yaml', 'yml'];
  const excludeFiles = ext.exclude || ['secrets.yaml'];

  let content = `# Only track specific file types\n# Ignore everything by default\n*\n\n`;

  // Start managed section
  content += `${MANAGED_START}\n`;

  // Add included extensions
  content += `# Tracked file types\n`;
  for (const extension of includeExts) {
    const cleanExt = extension.replace(/^\./, ''); // Remove leading dot if present
    content += `!*.${cleanExt}\n`;
    if (configOptions.invisible_files) {
      content += `!**/.??*.${cleanExt}\n`;
    }
  }

  // Add storage files
  const storageFiles = ext.storage || ['lovelace', 'lovelace_dashboards', 'lovelace_resources', 'lovelace.*'];
  if (storageFiles.length > 0) {
    content += `\n# Track specific .storage configuration files\n`;
    for (const file of storageFiles) {
      content += `!.storage/${file}\n`;
    }
  }

  // End managed section
  content += `${MANAGED_END}\n`;

  content += `\n# Allow directory traversal\n!*/\n`;

  // Re-ignore macOS metadata files (even if they match allowed extensions)
  content += `\n# Re-ignore macOS metadata files (even if they match allowed extensions)\n`;
  content += `._*\n`;

  // Add dynamically found nested git repos
  if (extraIgnores.length > 0) {
    content += `\n# Ignore nested git repositories to prevent submodule conflicts\n`;
    for (const ignoredPath of extraIgnores) {
      content += `/${ignoredPath}\n`;
      content += `/${ignoredPath}/**\n`;
    }
  }

  // Add excluded files (secrets.yaml, etc.)
  if (excludeFiles.length > 0) {
    content += `\n# Excluded files\n`;
    for (const file of excludeFiles) {
      content += `${file}\n`;
    }
  }

  // Add excluded folders
  const excludeFolders = ext.excludeFolders || [];
  if (excludeFolders.length > 0) {
    content += `\n# Excluded folders\n`;
    for (const folder of excludeFolders) {
      const normalizedFolder = folder.replace(/[\\\/]$/, '');
      content += `${normalizedFolder}/\n`;
      content += `${normalizedFolder}/**\n`;
    }
  }

  return content;
}

/**
 * Format commit message based on number of files changed
 * @param {Object} status - Git status object from simple-git
 * @param {string} fallbackName - Fallback name for single file
 * @returns {string} Formatted commit message
 */
function formatCommitMessage(status, fallbackName = null) {
  const files = status.files || [];
  const fileCount = files.length;

  if (fileCount === 1) {
    // Single file - use the filename
    const filename = files[0].path || fallbackName;
    return filename;
  } else {
    // Multiple files - show count
    return `${fileCount} files`;
  }
}

async function loadRuntimeSettings() {
  const settingSources = {};

  // Layer 0: Initialize sources as defaults
  for (const key of Object.keys(runtimeSettings)) {
    settingSources[key] = 'default';
  }

  // Layer 1: Apply environment variables
  const envResult = loadSettingsFromEnv();
  
  // Handle nested extensions if provided via env
  if (envResult.settings.includeExtensions) {
    runtimeSettings.extensions.include = envResult.settings.includeExtensions;
    delete envResult.settings.includeExtensions;
  }
  if (envResult.settings.excludeFiles) {
    runtimeSettings.extensions.exclude = envResult.settings.excludeFiles;
    delete envResult.settings.excludeFiles;
  }
  if (envResult.settings.excludeFolders) {
    runtimeSettings.extensions.excludeFolders = envResult.settings.excludeFolders;
    delete envResult.settings.excludeFolders;
  }
  if (envResult.settings.includeStorage) {
    runtimeSettings.extensions.storage = envResult.settings.includeStorage;
    delete envResult.settings.includeStorage;
  }
  
  runtimeSettings = { ...runtimeSettings, ...envResult.settings };
  Object.assign(settingSources, envResult.sources);

  // Layer 2: Apply file settings (highest precedence)
  try {
    const settingsPath = '/data/runtime-settings.json';
    try {
      await fsPromises.access(settingsPath, fs.constants.F_OK);
      const settingsData = await fsPromises.readFile(settingsPath, 'utf-8');
      const fileSettings = JSON.parse(settingsData);

      // Deep merge logic for specific nested objects to avoid losing defaults
      for (const [key, value] of Object.entries(fileSettings)) {
        if ((key === 'cloudSync' || key === 'extensions') && value && typeof value === 'object') {
          // Merge nested properties instead of replacing
          runtimeSettings[key] = { 
            ...runtimeSettings[key], 
            ...value 
          };
          settingSources[key] = 'file';
        } else if (runtimeSettings.hasOwnProperty(key)) {
          runtimeSettings[key] = value;
          settingSources[key] = 'file';
        }
      }
    } catch (e) {
      if (e.code === 'ENOENT') {
        console.log(`[init] No settings file found at ${settingsPath}, using environment and defaults.`);
      } else {
        throw e;
      }
    }

    // Ensure cloudSync exists (Beta feature)
    if (!runtimeSettings.cloudSync) {
      runtimeSettings.cloudSync = {
        enabled: false,
        remoteUrl: '',
        authToken: '',
        pushFrequency: 'manual',
        includeSecrets: false
      };
    }

    // Log final configuration with sources
    console.log('[init] Runtime settings loaded:');
    for (const [key, value] of Object.entries(runtimeSettings)) {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) continue; // skip nested objects for summary logging
      const source = settingSources[key] || 'unknown';
      const displayValue = typeof value === 'string' ? `'${value}'` : value;
      console.log(`[init]   ${key}: ${displayValue} (${source})`);
    }
  } catch (error) {
    console.error('[init] Error loading runtime settings:', error.message);
    console.log('[init] Using environment variables and defaults due to error.');
  }
}

/**
 * Save runtime settings to file
 */
async function saveRuntimeSettings() {
  try {
    const settingsPath = '/data/runtime-settings.json';
    console.log(`[settings] Saving settings to ${settingsPath}...`);

    await fsPromises.writeFile(settingsPath, JSON.stringify(runtimeSettings, null, 2), 'utf-8');
    console.log('[settings] Successfully saved runtime settings');
  } catch (error) {
    console.error('[settings] Failed to save runtime settings:', error);
    // Don't throw, just log, so we don't crash requests
  }
}

/**
 * Convert retention settings to milliseconds
 * @returns {number} Retention period in milliseconds
 */
function getRetentionPeriodMs() {
  const value = parseInt(runtimeSettings.retentionValue);
  const unit = runtimeSettings.retentionUnit;
  console.log(`[retention] Calculating retention period: value=${value}, unit=${unit}`);
  switch (unit) {
    case 'hours':
      return value * 60 * 60 * 1000;
    case 'days':
      return value * 24 * 60 * 60 * 1000;
    case 'weeks':
      return value * 7 * 24 * 60 * 60 * 1000;
    case 'months':
      return value * 30 * 24 * 60 * 60 * 1000; // Approximate
    default:
      return 30 * 24 * 60 * 60 * 1000; // Default 30 days
  }
}

/**
 * Convert debounce time settings to milliseconds
 * @returns {number} Debounce period in milliseconds
 */
function getDebounceTimeMs() {
  const value = parseInt(runtimeSettings.debounceTime);
  const unit = runtimeSettings.debounceTimeUnit;

  switch (unit) {
    case 'seconds':
      return value * 1000;
    case 'minutes':
      return value * 60 * 1000;
    case 'hours':
      return value * 60 * 60 * 1000;
    case 'days':
      return value * 24 * 60 * 60 * 1000;
    default:
      return value * 1000; // Default to seconds
  }
}

/**
 * Get all config files matching allowed extensions
 * @returns {Promise<Array<string>>} Array of file paths
 */
async function getConfigFiles() {
  const { glob } = await import('fs');
  const extensions = getConfiguredExtensions();
  const storagePatterns = getConfiguredStoragePatterns();

  if (extensions.length === 0 && storagePatterns.length === 0) {
    console.log('[getConfigFiles] No file formats or storage patterns enabled, returning empty array');
    return [];
  }

  const globSearch = (pattern) => new Promise((resolve, reject) => {
    glob(pattern, { nodir: true }, (err, files) => {
      if (err) reject(err);
      else resolve(files);
    });
  });

  const fileSet = new Set();

  if (extensions.length > 0) {
    // Build pattern like: /config/**/*.{yaml,yml,conf}
    const extensionNames = extensions
      .map(ext => ext.replace(/^\./, ''))
      .filter(Boolean);
    const extensionPattern = `${CONFIG_PATH}/**/*.{${extensionNames.join(',')}}`;
    const extensionFiles = await globSearch(extensionPattern);
    extensionFiles.forEach(file => fileSet.add(file));
  }

  for (const storagePattern of storagePatterns) {
    const cleanPattern = storagePattern.replace(/^\/+/, '');
    const pattern = `${CONFIG_PATH}/.storage/${cleanPattern}`;
    const storageFiles = await globSearch(pattern);
    storageFiles.forEach(file => fileSet.add(file));
  }

  return Array.from(fileSet);
}

/**
 * Find all nested .git directories
 * @returns {Promise<Array<string>>} List of relative paths to directories containing .git
 */
async function findNestedGitRepos() {
  const { promises: fsPromises } = await import('fs');
  const nestedRepos = [];

  try {
    // Recursive readdir available in Node 20+
    const files = await fsPromises.readdir(CONFIG_PATH, { recursive: true, withFileTypes: true });

    for (const file of files) {
      if (file.isDirectory() && file.name === '.git') {
        // file.parentPath (Node 20+) is the absolute path to the parent directory (if readdir called with abs path)
        // file.path is alias to parentPath in newer node
        const parentDir = file.parentPath || file.path;

        // Ensure we have absolute path to the directory containing .git
        const repoDir = path.isAbsolute(parentDir) ? parentDir : path.join(CONFIG_PATH, parentDir);

        const gitDir = path.join(repoDir, file.name);

        // Exclude root .git
        const rootGit = path.join(CONFIG_PATH, '.git');
        if (gitDir === rootGit) {
          continue;
        }

        // The repo dir is the directory containing .git (which is repoDir)
        const relativePath = path.relative(CONFIG_PATH, repoDir);

        if (relativePath && relativePath !== '.') {
          nestedRepos.push(relativePath);
        }
      }
    }

    if (nestedRepos.length > 0) {
      console.log('[nested-repos] Found nested git repositories:', nestedRepos);
    }
  } catch (e) {
    console.error('[nested-repos] Error finding nested repos:', e);
  }
  return nestedRepos;
}


/**
 * Set up SSH keys from the persistent /config/.ssh directory
 * This allows SSH keys to persist across addon updates/restarts
 */
async function setupSshKeys() {
  try {
    const sourceDir = path.join(CONFIG_PATH, '.ssh');
    const destDir = path.join(process.env.HOME || '/root', '.ssh');

    // Check if source directory exists
    try {
      await fsPromises.access(sourceDir);
    } catch (e) {
      // Source .ssh directory doesn't exist, nothing to do
      return;
    }

    console.log(`[ssh] Found SSH directory at ${sourceDir}, setting up system SSH...`);

    // Ensure destination directory exists
    try {
      await fsPromises.access(destDir);
    } catch (e) {
      await fsPromises.mkdir(destDir, { recursive: true, mode: 0o700 });
    }

    // List files in source directory
    const files = await fsPromises.readdir(sourceDir);

    for (const file of files) {
      const srcPath = path.join(sourceDir, file);
      const destPath = path.join(destDir, file);

      // Skip directories (like sockets or subdirs)
      const stats = await fsPromises.stat(srcPath);
      if (stats.isDirectory()) continue;

      // Copy file
      await fsPromises.copyFile(srcPath, destPath);

      // Set permissions: 600 for keys (SSH is strict about this)
      await fsPromises.chmod(destPath, 0o600);
      console.log(`[ssh] Copied and secured: ${file}`);
    }

    // Default SSH config if none exists in source
    const destConfigFile = path.join(destDir, 'config');
    try {
      await fsPromises.access(destConfigFile);
    } catch (e) {
      // Create a default config to disable host key checking for common git providers
      // This improves UX since users can't easily answer the "trust this host?" prompt
      const defaultSSHConfig = `
Host github.com
  StrictHostKeyChecking no
  UserKnownHostsFile /dev/null

Host gitlab.com
  StrictHostKeyChecking no
  UserKnownHostsFile /dev/null

Host bitbucket.org
  StrictHostKeyChecking no
  UserKnownHostsFile /dev/null
`;
      await fsPromises.writeFile(destConfigFile, defaultSSHConfig, { mode: 0o600 });
      console.log('[ssh] Created default SSH config with StrictHostKeyChecking disabled for common hosts');
    }

    console.log('[ssh] SSH setup complete');
  } catch (error) {
    console.error('[ssh] Setup failed:', error.message);
  }
}

/**
 * Set up CA certificates from the persistent /config/additional_ca directory
 * This allows the addon to trust the same root CAs as Home Assistant
 */
async function setupCaCertificates() {
  try {
    const sourceDir = path.join(CONFIG_PATH, 'additional_ca');
    const destDir = '/usr/local/share/ca-certificates';

    // Check if source directory exists
    try {
      await fsPromises.access(sourceDir);
    } catch (e) {
      // Source directory doesn't exist, nothing to do
      return;
    }

    console.log(`[init] Found additional CA directory at ${sourceDir}, setting up system certificates...`);

    // Ensure destination directory exists (usually it does in alpine)
    try {
      await fsPromises.access(destDir);
    } catch (e) {
      await fsPromises.mkdir(destDir, { recursive: true });
    }

    // List files in source directory
    const files = await fsPromises.readdir(sourceDir);
    let copiedCount = 0;

    for (const file of files) {
      if (file.toLowerCase().endsWith('.crt')) {
        const srcPath = path.join(sourceDir, file);
        const destPath = path.join(destDir, file);

        // Copy file
        await fsPromises.copyFile(srcPath, destPath);
        console.log(`[init] Copied CA certificate: ${file}`);
        copiedCount++;
      }
    }

    if (copiedCount > 0) {
      console.log(`[init] Updating system CA trust store...`);
      try {
        execSync('update-ca-certificates', { stdio: 'pipe' });
        console.log('[init] CA certificates updated successfully');
      } catch (updateError) {
        console.error('[init] Failed to update CA certificates:', updateError.message);
      }
    } else {
      console.log('[init] No .crt files found in additional_ca directory');
    }

  } catch (error) {
    console.error('[init] CA certificate setup failed:', error.message);
  }
}

async function initRepo() {
  // Load runtime settings first
  await loadRuntimeSettings();

  // Configure git (respects manualMode loaded in loadRuntimeSettings)
  configureGitIdentity();

  try {
    // Determine CONFIG_PATH
    CONFIG_PATH = process.env.CONFIG_PATH;

    // Also check for config.json in the data directory
    try {
      const configData = await fsPromises.readFile('/data/options.json', 'utf-8');
      const config = JSON.parse(configData);
      if (config.liveConfigPath) {
        CONFIG_PATH = config.liveConfigPath;
      }
      // Load extensions from add-on config - these merge with runtimeSettings
      if (config.include_extensions && Array.isArray(config.include_extensions) && config.include_extensions.length > 0) {
        const configInclude = config.include_extensions
          .map(ext => ext.trim().replace(/^\./, '')) // Remove leading dots
          .filter(ext => ext.length > 0);
        
        runtimeSettings.extensions.include = Array.from(new Set([
          ...(runtimeSettings.extensions.include || []),
          ...configInclude
        ]));
        console.log(`[init] Include extensions (merged):`, runtimeSettings.extensions.include);
      }
      // Support both exclude and exclude_files for flexibility (#29)
      const excludeConfig = config.exclude_files || config.exclude;
      if (excludeConfig && Array.isArray(excludeConfig) && excludeConfig.length > 0) {
        const configExclude = excludeConfig
          .map(file => file.trim())
          .filter(file => file.length > 0);
        
        runtimeSettings.extensions.exclude = Array.from(new Set([
          ...(runtimeSettings.extensions.exclude || []),
          ...configExclude
        ]));
        console.log(`[init] Exclude files (merged):`, runtimeSettings.extensions.exclude);
      }
      if (config.exclude_folders && Array.isArray(config.exclude_folders) && config.exclude_folders.length > 0) {
        const configExcludeFolders = config.exclude_folders
          .map(folder => folder.trim())
          .filter(folder => folder.length > 0);
        
        runtimeSettings.extensions.excludeFolders = Array.from(new Set([
          ...(runtimeSettings.extensions.excludeFolders || []),
          ...configExcludeFolders
        ]));
        console.log(`[init] Exclude folders (merged):`, runtimeSettings.extensions.excludeFolders);
      }
      if (config.include_storage && Array.isArray(config.include_storage) && config.include_storage.length > 0) {
        const configStorage = config.include_storage
          .map(file => file.trim())
          .filter(file => file.length > 0);
        
        runtimeSettings.extensions.storage = Array.from(new Set([
          ...(runtimeSettings.extensions.storage || []),
          ...configStorage
        ]));
        console.log(`[init] Include storage files (merged):`, runtimeSettings.extensions.storage);
      }
      if (config.additional_paths && Array.isArray(config.additional_paths)) {
        runtimeSettings.additionalPaths = config.additional_paths;
        console.log(`[init] Additional paths from config:`, runtimeSettings.additionalPaths);
      }
      if (config.watcher_use_polling !== undefined) {
        runtimeSettings.watcherUsePolling = !!config.watcher_use_polling;
        console.log(`[init] Watcher use polling from config:`, runtimeSettings.watcherUsePolling);
      }
      if (config.watcher_interval !== undefined) {
        runtimeSettings.watcherInterval = parseInt(config.watcher_interval) || 2000;
        console.log(`[init] Watcher interval from config:`, runtimeSettings.watcherInterval);
      }
      if (config.manual_mode !== undefined) {
        runtimeSettings.manualMode = !!config.manual_mode;
        console.log(`[init] Manual mode from config: ${runtimeSettings.manualMode}`);
      }

      // Handle remote_url from config.json
      if (config.remote_url && config.remote_url.trim() !== '' && config.remote_url !== runtimeSettings.cloudSync.remoteUrl) {
        console.log(`[init] Remote URL from config: ${config.remote_url}`);
        runtimeSettings.cloudSync.remoteUrl = config.remote_url;

        // Auto-detect provider if not set
        if (!runtimeSettings.cloudSync.authProvider) {
          if (config.remote_url.includes('github.com')) {
            runtimeSettings.cloudSync.authProvider = 'github';
            runtimeSettings.cloudSync.githubRemoteUrl = config.remote_url;
          } else {
            runtimeSettings.cloudSync.authProvider = 'custom';
            runtimeSettings.cloudSync.customRemoteUrl = config.remote_url;
          }
        }

        // We will apply this to git after initialization/verification
        global.pendingRemoteUpdate = true;
      }
    } catch (error) {
      // Ignore if file doesn't exist
    }


    // Synchronize format options with final extensions configuration
    const include = runtimeSettings.extensions.include || [];
    configOptions.json_format = include.includes('json');
    configOptions.py_format = include.includes('py');
    configOptions.txt_format = include.includes('txt');
    configOptions.yaml_format = include.includes('yaml') || include.includes('yml');

    console.log(`[init] Synchronized file format options:`, configOptions);

    // Default to /config
    if (!CONFIG_PATH) {
      CONFIG_PATH = '/config';
    }

    additionalTrackedPaths = sanitizeAdditionalPaths(runtimeSettings.additionalPaths || []);
    runtimeSettings.additionalPaths = additionalTrackedPaths;

    console.log(`[init] CONFIG_PATH: ${CONFIG_PATH}`);
    console.log(`[init] Additional tracked paths:`, additionalTrackedPaths);
    console.log(`[init] Current working directory: ${process.cwd()}`);

    // Set up SSH keys from /config/.ssh if present
    await setupSshKeys();

    // Set up CA certificates from /config/additional_ca if present
    await setupCaCertificates();

    // Initialize git with the correct path
    global.CONFIG_PATH = CONFIG_PATH;

    // Check if directory exists
    try {
      await fsPromises.access(CONFIG_PATH);
    } catch (error) {
      console.log(`[init] CONFIG_PATH does not exist, creating it...`);
      await fsPromises.mkdir(CONFIG_PATH, { recursive: true });
    }

    const externalSyncStats = await syncAllAdditionalPathsToMirror();
    if (externalSyncStats.paths > 0) {
      console.log(`[external-sync] Startup sync complete: paths=${externalSyncStats.paths}, copied=${externalSyncStats.copied}, removed=${externalSyncStats.removed}`);
    }

    const isRepo = await gitCheckIsRepo();

    // Check for nested git repositories to ignore
    const nestedRepos = await findNestedGitRepos();
    if (nestedRepos.length > 0) {
      IGNORED_NESTED_REPOS.push(...nestedRepos);
    }

    if (!isRepo) {
      console.log(`[init] Initializing Git repo at ${CONFIG_PATH}...`);
      await gitExec(['init', '-b', 'main']);

      // Create .gitignore to limit git to only config files
      if (!runtimeSettings.manualMode) {
        const gitignorePath = path.join(CONFIG_PATH, '.gitignore');
        const gitignoreContent = generateGitignoreContent(nestedRepos, runtimeSettings.extensions);
        try {
          await fsPromises.access(gitignorePath, fs.constants.F_OK);
          console.log('[init] .gitignore already exists in CONFIG_PATH');
        } catch (error) {
          console.log('[init] Creating .gitignore in CONFIG_PATH to limit git to config files only...');
          await fsPromises.writeFile(gitignorePath, gitignoreContent, 'utf8');
          console.log('[init] Created .gitignore in CONFIG_PATH');
        }
      } else {
        console.log('[init] Manual mode active: skipping .gitignore creation');
      }

      if (!runtimeSettings.manualMode) {
        // Add all files - this respects the .gitignore we just created
        // Using '.' instead of explicit file list so .gitignore patterns are respected
        try {
          await gitAdd('.');
          console.log(`[init] Added all files (respecting .gitignore patterns)`);
        } catch (error) {
          if (error.message.includes('ignored') || error.message.includes('gitignore')) {
            console.log(`[init] Some files are ignored, trying with --force flag...`);
            await gitAdd('.');
            console.log(`[init] Added all files (forced)`);
          } else {
            throw error;
          }
        }

        // Check status to see what was actually added
        const status = await gitStatus();

        // Create initial commit with formatted message
        const startupMessage = formatCommitMessage(status);
        await gitCommit(startupMessage);
        console.log('Initialized Git repo with startup backup');
        console.log(`[log] ════════════════════════════════════════════════════`);
        console.log(`[log] Initial commit created (first backup)`);
        console.log(`[log] Message: ${startupMessage}`);
        console.log(`[log] Files: ${status.files.length}`);
        console.log(`[log] ════════════════════════════════════════════════════`);
      } else {
        console.log('[init] Manual mode active: skipping initial commit');
      }
    } else {
      console.log('Using existing Git repo');
    }

    // Test write access
    try {
      await fsPromises.access(CONFIG_PATH, fs.constants.W_OK);
      console.log(`[init] Write access confirmed for ${CONFIG_PATH}`);
    } catch (error) {
      console.error(`[init] No write access to ${CONFIG_PATH}!`);
      console.error('[init] This is a critical error - the addon will not be able to commit changes');
      throw new Error(`No write permission to CONFIG_PATH: ${CONFIG_PATH}`);
    }

    // Handle .gitignore for existing repos
    if (isRepo && !runtimeSettings.manualMode) {
      const gitignorePath = path.join(CONFIG_PATH, '.gitignore');
      try {
        await fsPromises.access(gitignorePath, fs.constants.F_OK);

        // Always update .gitignore to ensure extensions from config are applied
        console.log('[init] Updating .gitignore with configured extensions...');
        const existingContent = await fsPromises.readFile(gitignorePath, 'utf8');
        const newContent = generateGitignoreContent(nestedRepos, runtimeSettings.extensions);

        // Only update if content actually changed
        if (existingContent.trim() !== newContent.trim()) {
          await fsPromises.writeFile(gitignorePath, newContent, 'utf8');
          console.log('[init] Updated .gitignore with extensions:', runtimeSettings.extensions);
        } else {
          console.log('[init] .gitignore already up to date');
        }
      } catch (error) {
        // .gitignore doesn't exist, create default one
        console.log('[init] Creating default .gitignore in CONFIG_PATH...');
        const gitignoreContent = generateGitignoreContent(nestedRepos, runtimeSettings.extensions);
        await fsPromises.writeFile(gitignorePath, gitignoreContent, 'utf8');
        console.log('[init] Created .gitignore in CONFIG_PATH');
      }
    } else if (isRepo && runtimeSettings.manualMode) {
      console.log('[init] Manual mode active: skipping .gitignore update for existing repository');
    }

    // Clean up nested repos from index BEFORE doing git add
    // This prevents them from being re-committed in the startup backup
    if (nestedRepos.length > 0 && !runtimeSettings.manualMode) {
      console.log('[init] Cleaning up nested git repositories from index...');
      for (const repoPath of nestedRepos) {
        // Ensure path uses forward slashes for git command
        const gitPath = repoPath.replace(/\\/g, '/');
        const removed = await gitRmCached(gitPath);
        if (removed) {
          console.log(`[init] Removed nested git repo from index (cached only): ${gitPath}`);
        }
      }
    }

    // Create a startup commit to backup current state (only for existing repos)
    if (isRepo && !runtimeSettings.manualMode) {
      console.log('[init] Creating startup backup commit for existing repository...');

      // Add all files - this respects the .gitignore patterns
      // Using '.' instead of explicit file list so .gitignore is respected
      try {
        await gitAdd('.');
        console.log(`[init] Added all files (respecting .gitignore patterns)`);
      } catch (error) {
        if (error.message.includes('ignored') || error.message.includes('gitignore')) {
          console.log(`[init] Some files are ignored, trying with --force flag...`);
          await gitAdd('.');
          console.log(`[init] Added all files (forced)`);
        } else {
          throw error;
        }
      }

      // After git add, unstage any nested repos to prevent them from being committed
      // This handles both re-additions (as submodules) and deletions staged by git rm --cached
      if (nestedRepos.length > 0) {
        console.log('[init] Unstaging nested git repositories after git add...');
        for (const repoPath of nestedRepos) {
          const gitPath = repoPath.replace(/\\/g, '/');
          await gitResetHead(gitPath);
          console.log(`[init] Unstaged nested repo: ${gitPath}`);
        }
      }

      // Check if there are any changes first
      const status = await gitStatus();
      console.log(`[init] Git status - isClean: ${status.isClean()}`);

      if (!status.isClean()) {
        // Non-empty commit - show file count or filename
        const startupMessage = formatCommitMessage(status);
        await gitCommit(startupMessage);
        console.log(`[init] Created startup backup commit with ${status.files.length} files`);
        console.log(`[log] ════════════════════════════════════════════════════`);
        console.log(`[log] Startup backup commit created`);
        console.log(`[log] Message: ${startupMessage}`);
        console.log(`[log] Files: ${status.files.length}`);
        console.log(`[log] ════════════════════════════════════════════════════`);
      } else {
        // No changes - don't create empty commit (wastes retention space)
        console.log(`[init] No changes detected - skipping empty baseline commit`);
        console.log(`[init] Repository is ready (empty baseline commits are disabled to save retention space)`);
      }
    } else if (isRepo && runtimeSettings.manualMode) {
      console.log('[init] Manual mode active: skipping startup backup commit');
    }

    // Apply pending remote update from config
    if (global.pendingRemoteUpdate && runtimeSettings.cloudSync.remoteUrl) {
      console.log(`[init] Applying pending remote URL update: ${runtimeSettings.cloudSync.remoteUrl}`);
      const remoteResult = await setupGitRemote(runtimeSettings.cloudSync.remoteUrl, runtimeSettings.cloudSync.authToken);
      if (remoteResult.success) {
        console.log('[init] Successfully updated git remote from config');
        await saveRuntimeSettings();
      } else {
        console.error('[init] Failed to update git remote from config:', remoteResult.error);
      }
      global.pendingRemoteUpdate = false;
    }

    gitInitialized = true;
  } catch (error) {
    console.error('Git init error:', error);
    // Don't fail hard, continue starting the server
  }
}

// App settings endpoint
app.get('/api/app-settings', async (req, res) => {
  res.json({
    mode: 'docker',
    haUrl: null,
    haToken: null,
    haAuthMode: 'none',
    haAuthConfigured: false,
    liveConfigPath: CONFIG_PATH,
    backupFolderPath: null,
    haCredentialsSource: 'none'
  });
});

// Get runtime settings
app.get('/api/runtime-settings', async (req, res) => {
  try {
    res.json({
      success: true,
      settings: runtimeSettings
    });
  } catch (error) {
    console.error('[runtime-settings] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Save runtime settings
app.post('/api/runtime-settings', async (req, res) => {
  try {
    const newSettings = req.body;

    // Validate and update settings
    if (newSettings.debounceTime !== undefined) {
      const debounceTime = parseInt(newSettings.debounceTime);
      if (debounceTime >= 0) {
        runtimeSettings.debounceTime = debounceTime;
      }
    }

    if (newSettings.debounceTimeUnit !== undefined) {
      const validUnits = ['seconds', 'minutes', 'hours', 'days'];
      if (validUnits.includes(newSettings.debounceTimeUnit)) {
        runtimeSettings.debounceTimeUnit = newSettings.debounceTimeUnit;
      }
    }

    if (newSettings.historyRetention !== undefined) {
      runtimeSettings.historyRetention = newSettings.historyRetention;
    }

    if (newSettings.manualMode !== undefined) {
      runtimeSettings.manualMode = !!newSettings.manualMode;
    }

    if (newSettings.retentionType !== undefined) {
      runtimeSettings.retentionType = newSettings.retentionType;
    }

    if (newSettings.retentionValue !== undefined) {
      const retentionValue = parseInt(newSettings.retentionValue);
      if (retentionValue >= 1) {
        runtimeSettings.retentionValue = retentionValue;
      }
    }

    if (newSettings.retentionUnit !== undefined) {
      runtimeSettings.retentionUnit = newSettings.retentionUnit;
    }

    if (newSettings.limitHistory !== undefined) {
      runtimeSettings.limitHistory = !!newSettings.limitHistory;
    }

    if (newSettings.maxCommits !== undefined) {
      const maxCommits = parseInt(newSettings.maxCommits);
      if (maxCommits >= 0) {
        runtimeSettings.maxCommits = maxCommits;
      }
    }

    // Handle extensions settings
    if (newSettings.extensions !== undefined) {
      const oldExclude = [...(runtimeSettings.extensions.exclude || [])];

      if (newSettings.extensions.include !== undefined && Array.isArray(newSettings.extensions.include)) {
        runtimeSettings.extensions.include = newSettings.extensions.include
          .map(ext => ext.trim().replace(/^\./, '')) // Remove leading dots
          .filter(ext => ext.length > 0);
      }
      if (newSettings.extensions.exclude !== undefined && Array.isArray(newSettings.extensions.exclude)) {
        runtimeSettings.extensions.exclude = newSettings.extensions.exclude
          .map(file => file.trim())
          .filter(file => file.length > 0);
      }
      if (newSettings.extensions.excludeFolders !== undefined && Array.isArray(newSettings.extensions.excludeFolders)) {
        runtimeSettings.extensions.excludeFolders = newSettings.extensions.excludeFolders
          .map(folder => folder.trim())
          .filter(folder => folder.length > 0);
      }
      if (newSettings.extensions.storage !== undefined && Array.isArray(newSettings.extensions.storage)) {
        runtimeSettings.extensions.storage = newSettings.extensions.storage
          .map(pattern => pattern.trim())
          .filter(pattern => pattern.length > 0);
        console.log(`[settings] Updated include_storage:`, runtimeSettings.extensions.storage);
      }

      // Synchronize format options with updated extensions
      const include = runtimeSettings.extensions.include || [];
      configOptions.json_format = include.includes('json');
      configOptions.py_format = include.includes('py');
      configOptions.txt_format = include.includes('txt');
      configOptions.yaml_format = include.includes('yaml') || include.includes('yml');
      console.log(`[settings] Updated file format options:`, configOptions);

      const newExclude = runtimeSettings.extensions.exclude || [];
      const newlyExcluded = newExclude.filter(file => !oldExclude.includes(file));

      // Regenerate .gitignore with new extensions
      try {
        const gitignorePath = path.join(CONFIG_PATH, '.gitignore');
        const newContent = generateGitignoreContent(IGNORED_NESTED_REPOS, runtimeSettings.extensions);
        await fsPromises.writeFile(gitignorePath, newContent, 'utf8');
        console.log('[settings] Updated .gitignore with new extensions');

        const externalSyncStats = await syncAllAdditionalPathsToMirror();
        if (externalSyncStats.paths > 0) {
          console.log(`[external-sync] Re-synced additional paths after extension update: copied=${externalSyncStats.copied}, removed=${externalSyncStats.removed}`);
        }

        // Handle untracking files when settings change
        let removedAny = false;

        // 1. Automatically untrack files that were just added to the exclude list
        if (newlyExcluded.length > 0) {
          console.log(`[settings] Newly excluded files detected: ${newlyExcluded.join(', ')}`);
          for (const file of newlyExcluded) {
            // Unwatch if the watcher is active to save resources
            if (watcher && typeof watcher.unwatch === 'function') {
              const fullPathToUnwatch = path.isAbsolute(file) ? file : path.join(CONFIG_PATH, file);
              watcher.unwatch(fullPathToUnwatch);
              console.log(`[settings] Unwatching newly excluded path: ${fullPathToUnwatch}`);
            }

            const removed = await gitRmCached(file);
            if (removed) {
              console.log(`[settings] Successfully untracked newly excluded file: ${file}`);
              removedAny = true;
            }
          }
        }

        // 2. Also cleanup tracked .storage files that are no longer in the allowed list
        try {
          const trackedStorageFiles = (await gitRaw(['ls-files', '.storage/'])).trim().split('\n').filter(Boolean);
          for (const file of trackedStorageFiles) {
            if (!isConfiguredStorageRepoPath(file)) {
              console.log(`[settings] Untracking .storage file no longer in allowed list: ${file}`);
              const removed = await gitRmCached(file);
              if (removed) {
                removedAny = true;
                // Unwatch as well
                if (watcher && typeof watcher.unwatch === 'function') {
                  const fullPathToUnwatch = path.join(CONFIG_PATH, file);
                  watcher.unwatch(fullPathToUnwatch);
                }
              }
            }
          }
        } catch (storageError) {
          // No .storage files or git error - if it's "not a git repository" etc, but here we assume it is
          if (!storageError.message.includes('not a git repository')) {
            console.log('[settings] Checked .storage for cleanup:', storageError.message);
          }
        }

        // 3. Commit cleanup changes and .gitignore update
        if (removedAny || true) { // Always commit if .gitignore changed (which it did at line 1721)
          try {
            await gitAdd('.gitignore');
            const msg = newlyExcluded.length > 0 ?
              `Exclude ${newlyExcluded.join(', ')} and update .gitignore` :
              'Update .gitignore and tracked files';
            
            // Check if there are changes to commit
            const status = await gitStatus();
            if (!status.isClean()) {
              await gitCommit(msg);
              console.log(`[settings] Committed configuration changes: ${msg}`);
            }
          } catch (e) {
            console.log('[settings] No changes to commit after update:', e.message);
          }
        }
      } catch (error) {
        console.error('[settings] Failed to update .gitignore or untrack files:', error);
      }
    }

    // Save to file
    await saveRuntimeSettings();

    res.json({
      success: true,
      settings: runtimeSettings
    });
  } catch (error) {
    console.error('[runtime-settings] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// List all YAML files
app.get('/api/files', async (req, res) => {
  try {
    const walkDir = async (dir, base = '') => {
      let entries;
      try {
        entries = await fsPromises.readdir(dir, { withFileTypes: true });
      } catch (err) {
        console.error(`[walkDir] Error reading directory ${dir}:`, err.message);
        return []; // Return empty array for this directory and stop recursion
      }

      const files = [];
      const allowedExtensions = getConfiguredExtensions();

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relPath = base ? path.join(base, entry.name) : entry.name;

        // Skip files starting with ._ (macOS resource fork files)
        if (entry.name.startsWith('._')) {
          continue;
        }

        if (entry.isDirectory() && !entry.name.startsWith('.git') && !entry.name.startsWith('node_modules')) {
          files.push(...await walkDir(fullPath, relPath));
        } else if (entry.isFile()) {
          // Check if file matches any configured extension or configured .storage pattern
          const matchesExtension = allowedExtensions.some(ext =>
            entry.name.toLowerCase().endsWith(ext)
          );
          const isStorageFile = isConfiguredStorageRepoPath(relPath);

          if (matchesExtension || isStorageFile) {
            // Get file stats for mtime
            try {
              const stats = await fsPromises.stat(fullPath);
              files.push({
                path: relPath,
                mtime: stats.mtimeMs
              });
            } catch (e) {
              // Fallback if stat fails
              files.push({
                path: relPath,
                mtime: 0
              });
            }
          }
        }
      }
      return files;
    };

    const files = await walkDir(CONFIG_PATH);
    res.json({ success: true, files });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get deleted files (files that exist in git history but not on disk)
app.get('/api/files/deleted', async (req, res) => {
  try {
    ensureGitInitialized();
    console.log('[deleted-files] Scanning git history for deleted files...');

    // Get all files currently on disk (returns absolute paths)
    const currentFiles = await getConfigFiles();
    // Convert to relative paths for comparison with git history
    const currentFileSet = new Set(currentFiles.map(f => path.relative(CONFIG_PATH, f)));

    // Get all files ever tracked in git history (returns relative paths)
    // Use git log to find all files that were ever committed
    const gitLogOutput = await gitRaw(['log', '--all', '--name-only', '--pretty=format:', '--diff-filter=ACMRD']);
    const allHistoricalFiles = gitLogOutput
      .split('\n')
      .map(f => f.trim())
      .filter(f => f && !f.startsWith('.git'));

    // Get unique file paths from history
    const historicalFileSet = new Set(allHistoricalFiles);

    // Filter to only include configured extensions
    const allowedExtensions = getConfiguredExtensions();
    const deletedFiles = [];

    for (const filePath of historicalFileSet) {
      // Check if file matches allowed extensions or configured .storage pattern
      const matchesExtension = allowedExtensions.some(ext => filePath.toLowerCase().endsWith(ext));
      const isStorageFile = isConfiguredStorageRepoPath(filePath);

      // Check if file exists on disk (using absolute path)
      const absolutePath = path.join(CONFIG_PATH, filePath);
      const fileExistsOnDisk = fs.existsSync(absolutePath);

      if ((matchesExtension || isStorageFile) && !fileExistsOnDisk) {
        // File was tracked but no longer exists - find when it was last seen
        try {
          const lastCommitOutput = await gitRaw(['log', '-1', '--format=%H|%aI|%s', '--', filePath]);
          if (lastCommitOutput.trim()) {
            const [hash, date, message] = lastCommitOutput.trim().split('|');
            deletedFiles.push({
              path: filePath,
              name: path.basename(filePath),
              lastSeenDate: date,
              lastSeenHash: hash,
              lastSeenMessage: message
            });
          }
        } catch (e) {
          // File might not have proper history, skip it
          console.log(`[deleted-files] Could not get history for ${filePath}:`, e.message);
        }
      }
    }

    // Sort by last seen date (most recent first)
    deletedFiles.sort((a, b) => new Date(b.lastSeenDate) - new Date(a.lastSeenDate));

    console.log(`[deleted-files] Found ${deletedFiles.length} deleted files`);
    res.json({ success: true, files: deletedFiles });
  } catch (error) {
    console.error('[deleted-files] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get deleted automations (automations that exist in git history but not in current config)
app.get('/api/automations/deleted', async (req, res) => {
  try {
    ensureGitInitialized();
    console.log('[deleted-automations] Scanning git history for deleted automations...');

    // Get current automations
    const currentAutomations = await extractAutomations(CONFIG_PATH);
    const currentAutomationIds = new Set(currentAutomations.map(a => a.id));

    // Get all commits that touched automation files
    const { automationPaths } = await getConfigFilePaths(CONFIG_PATH);
    const allAutomationIds = new Map(); // id -> { name, file, lastSeenDate, lastSeenHash }

    // Scan each automation file's history
    for (const filePath of automationPaths) {
      const relPath = path.relative(CONFIG_PATH, filePath);
      try {
        // Get commit history for this file
        const logOutput = await gitRaw(['log', '--format=%H|%aI', '--', relPath]);
        const commits = logOutput.trim().split('\n').filter(l => l);

        for (const commitLine of commits.slice(0, 50)) { // Limit to 50 commits per file for performance
          const [hash, date] = commitLine.split('|');
          try {
            // Get file content at this commit
            const content = await gitShowFileAtCommit(hash, relPath);
            if (content) {
              // Parse YAML to find automation IDs
              const parsed = yaml.load(content);
              const automations = Array.isArray(parsed) ? parsed : (parsed && parsed.automations ? parsed.automations : []);

              const isArray = Array.isArray(automations);
              const collection = isArray ? automations : (typeof automations === 'object' ? automations : {});

              if (isArray) {
                collection.forEach((auto, index) => {
                  if (auto && typeof auto === 'object' && auto.alias) {
                    const uniqueId = auto.id || index;
                    const fullId = `automations:${encodeURIComponent(relPath)}:${uniqueId}`;

                    if (!currentAutomationIds.has(fullId)) {
                      // Double check: if we used index, maybe the current version has a UUID now?
                      // But we can't easily check that without loading the current automation content again.
                      // For now, relying on the ID format consistency should fix the main "everything deleted" bug.
                      // Also check if the raw ID exists in current set if available
                      // This is tricky because currentAutomationIds IS the set of full IDs.

                      // Attempt to match by raw ID if available, as a fallback?
                      // No, extractAutomations puts UUID in the ID if available. 
                      // So if history has UUID, fullId uses UUID. Current has UUID, fullId uses UUID. It matches.

                      const existing = allAutomationIds.get(fullId);
                      if (!existing || new Date(date) > new Date(existing.lastSeenDate)) {
                        allAutomationIds.set(fullId, {
                          id: fullId,
                          rawId: auto.id,
                          name: auto.alias || 'Unknown Automation',
                          file: relPath,
                          lastSeenDate: date,
                          lastSeenHash: hash
                        });
                      }
                    }
                  }
                });
              } else {
                // Object format
                Object.keys(collection).forEach(key => {
                  const auto = collection[key];
                  if (auto && typeof auto === 'object' && auto.alias) {
                    const uniqueId = auto.id || key;
                    const fullId = `automations:${encodeURIComponent(relPath)}:${uniqueId}`;

                    if (!currentAutomationIds.has(fullId)) {
                      const existing = allAutomationIds.get(fullId);
                      if (!existing || new Date(date) > new Date(existing.lastSeenDate)) {
                        allAutomationIds.set(fullId, {
                          id: fullId,
                          rawId: auto.id,
                          name: auto.alias || key,
                          file: relPath,
                          lastSeenDate: date,
                          lastSeenHash: hash
                        });
                      }
                    }
                  }
                });
              }
            }
          } catch (e) {
            // Skip commits where file/parsing fails
          }
        }
      } catch (e) {
        console.log(`[deleted-automations] Error scanning ${relPath}:`, e.message);
      }
    }

    // Convert to array and sort by last seen date
    const deletedAutomations = Array.from(allAutomationIds.values());
    deletedAutomations.sort((a, b) => new Date(b.lastSeenDate) - new Date(a.lastSeenDate));

    console.log(`[deleted-automations] Found ${deletedAutomations.length} deleted automations`);
    res.json({ success: true, automations: deletedAutomations });
  } catch (error) {
    console.error('[deleted-automations] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get deleted scripts (scripts that exist in git history but not in current config)
app.get('/api/scripts/deleted', async (req, res) => {
  try {
    ensureGitInitialized();
    console.log('[deleted-scripts] Scanning git history for deleted scripts...');

    // Get current scripts
    const currentScripts = await extractScripts(CONFIG_PATH);
    const currentScriptIds = new Set(currentScripts.map(s => s.id));

    // Get all commits that touched script files
    const { scriptPaths } = await getConfigFilePaths(CONFIG_PATH);
    const allScriptIds = new Map(); // id -> { name, file, lastSeenDate, lastSeenHash }

    // Scan each script file's history
    for (const filePath of scriptPaths) {
      const relPath = path.relative(CONFIG_PATH, filePath);
      try {
        // Get commit history for this file
        const logOutput = await gitRaw(['log', '--format=%H|%aI', '--', relPath]);
        const commits = logOutput.trim().split('\n').filter(l => l);

        for (const commitLine of commits.slice(0, 50)) { // Limit to 50 commits per file for performance
          const [hash, date] = commitLine.split('|');
          try {
            // Get file content at this commit
            const content = await gitShowFileAtCommit(hash, relPath);
            if (content) {
              // Parse YAML to find script IDs
              const parsed = yaml.load(content);
              if (parsed && typeof parsed === 'object') {
                // Standard scripts.yaml is an object key->config
                // But could technically be an array in some split configs? safely assume object for now as per previous logic
                // Actually extractScripts handles arrays too. Let's start with Object support as that's standard for scripts.yaml

                // Support array if it happens (though rare for scripts)
                if (Array.isArray(parsed)) {
                  parsed.forEach((script, index) => {
                    if (script && script.alias) {
                      const uniqueId = script.id || index;
                      const fullId = `scripts:${encodeURIComponent(relPath)}:${uniqueId}`;
                      if (!currentScriptIds.has(fullId)) {
                        const existing = allScriptIds.get(fullId);
                        if (!existing || new Date(date) > new Date(existing.lastSeenDate)) {
                          allScriptIds.set(fullId, {
                            id: fullId,
                            rawId: script.id,
                            name: script.alias || 'Unknown Script',
                            file: relPath,
                            lastSeenDate: date,
                            lastSeenHash: hash
                          });
                        }
                      }
                    }
                  });
                } else {
                  for (const [key, scriptConfig] of Object.entries(parsed)) {
                    // scriptConfig might be null or not have alias
                    if (scriptConfig && typeof scriptConfig === 'object') {
                      const uniqueId = scriptConfig.id || key;
                      const fullId = `scripts:${encodeURIComponent(relPath)}:${uniqueId}`;

                      if (!currentScriptIds.has(fullId)) {
                        const existing = allScriptIds.get(fullId);
                        if (!existing || new Date(date) > new Date(existing.lastSeenDate)) {
                          allScriptIds.set(fullId, {
                            id: fullId,
                            rawId: scriptConfig.id,
                            name: scriptConfig.alias || key,
                            file: relPath,
                            lastSeenDate: date,
                            lastSeenHash: hash
                          });
                        }
                      }
                    }
                  }
                }
              }
            }
          } catch (e) {
            // Skip commits where file/parsing fails
          }
        }
      } catch (e) {
        console.log(`[deleted-scripts] Error scanning ${relPath}:`, e.message);
      }
    }

    // Convert to array and sort by last seen date
    const deletedScripts = Array.from(allScriptIds.values());
    deletedScripts.sort((a, b) => new Date(b.lastSeenDate) - new Date(a.lastSeenDate));

    console.log(`[deleted-scripts] Found ${deletedScripts.length} deleted scripts`);
    res.json({ success: true, scripts: deletedScripts });
  } catch (error) {
    console.error('[deleted-scripts] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Git History
app.get('/api/git/history', async (req, res) => {
  try {
    const options = {};
    if (runtimeSettings.limitHistory) {
      options.maxCount = runtimeSettings.maxCommits;
    }
    const log = await gitLog(options);
    res.json({ success: true, log });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Git Commit Details
app.get('/api/git/commit-details', async (req, res) => {
  try {
    const { commitHash } = req.query;
    const status = await gitCommitDetails(commitHash);
    res.json({ success: true, status });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Manually add all untracked files and commit
app.post('/api/git/add-all-and-commit', async (req, res) => {
  try {
    ensureGitInitialized();
    console.log('[add-all-and-commit] Adding all config files and committing...');
    const configFiles = await getConfigFiles();
    console.log(`[add-all-and-commit] Found ${configFiles.length} config files to add`);
    await gitAdd(configFiles);
    const status = await gitStatus();
    if (status.isClean()) {
      console.log('[add-all-and-commit] No changes to commit.');
      return res.json({ success: true, message: 'No changes to commit.' });
    }
    const commitMessage = 'Manual commit: Add all config files and stage changes';
    await gitCommit(commitMessage);
    console.log(`[add-all-and-commit] Committed: ${commitMessage}`);
    res.json({ success: true, message: `All ${configFiles.length} config files added and committed.` });
  } catch (error) {
    console.error('[add-all-and-commit] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// File at commit
app.get('/api/git/file-at-commit', async (req, res) => {
  try {
    const { commitHash, filePath } = req.query;
    const content = await gitShowFileAtCommit(commitHash, filePath);
    res.json({ success: true, content });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get current file content from disk
app.get('/api/file-content', async (req, res) => {
  try {
    const { filePath } = req.query;

    let fullPath = path.join(CONFIG_PATH, filePath);
    if (isMirroredExternalRepoPath(filePath)) {
      const externalPath = repoPathToExternalAbsolute(filePath);
      if (externalPath && isPathInConfiguredAdditionalPaths(externalPath)) {
        fullPath = externalPath;
      }
    }

    const content = await fsPromises.readFile(fullPath, 'utf-8');
    res.json({ success: true, content });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// File history
app.get('/api/git/file-history', async (req, res) => {
  try {
    const { filePath } = req.query;
    const logOptions = { file: filePath };
    if (runtimeSettings.limitHistory) {
      logOptions.maxCount = runtimeSettings.maxCommits;
    }
    const log = await gitLog(logOptions);

    // Get current file hash
    let currentHash = '';
    try {
      // Use git hash-object to get the hash of the file on disk
      currentHash = (await gitRaw(['hash-object', filePath])).trim();
    } catch (e) {
      // File might not exist or other error
    }

    // Get blob hashes for each commit to allow efficient frontend filtering
    const commitsWithHashes = await Promise.all(log.all.map(async (commit) => {
      try {
        // git ls-tree <commit> <path>
        // Output format: <mode> blob <hash>\t<path>
        const treeOut = await gitRaw(['ls-tree', commit.hash, filePath]);
        const match = treeOut.match(/blob\s+([0-9a-f]+)/);
        const blobHash = match ? match[1] : null;
        return { ...commit, blobHash };
      } catch (e) {
        console.error(`Error getting blob hash for ${commit.hash}:`, e.message);
        return { ...commit, blobHash: null };
      }
    }));

    log.all = commitsWithHashes;

    res.json({ success: true, log, currentHash });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// File diff
app.get('/api/git/file-diff', async (req, res) => {
  try {
    const { filePath, commitHash } = req.query;
    const diff = await gitDiff([`${commitHash}^`, commitHash, '--', filePath]);
    res.json({ success: true, diff });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get full diff of a commit
app.get('/api/git/commit-diff', async (req, res) => {
  try {
    const { commitHash } = req.query;
    if (!commitHash) {
      return res.status(400).json({ success: false, error: 'commitHash is required' });
    }
    const diff = await gitDiff([`${commitHash}^`, commitHash]);
    res.json({ success: true, diff });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Restore file
app.post('/api/restore-file', async (req, res) => {
  try {
    const { commitHash, filePath } = req.body;
    console.log(`[restore] Restoring file ${filePath} to commit ${commitHash.substring(0, 8)}`);

    // Get the date from the commit for the commit message
    // Get the date from the commit for the commit message
    const dateStr = (await gitRaw(['show', '-s', '--format=%aI', commitHash])).trim();
    const commitDate = new Date(dateStr).toLocaleString();

    // Restore the file - file watcher will detect and auto-commit
    await restorePathToCommit(commitHash, filePath);
    console.log(`[restore] File restored: ${filePath}`);
    console.log(`[restore] File watcher will auto-commit this change`);

    let message = 'File restored (auto-commit pending)';

    // Check if we need to reload Home Assistant components
    if (filePath.endsWith('automations.yaml')) {
      console.log('[restore] Reloading automations in Home Assistant...');
      const reloadResult = await callHomeAssistantService('automation', 'reload');
      if (reloadResult.success) {
        message += '. Automations reloaded.';
      } else {
        message += `. Automations reload failed: ${reloadResult.error}`;
      }
    } else if (filePath.endsWith('scripts.yaml')) {
      console.log('[restore] Reloading scripts in Home Assistant...');
      const reloadResult = await callHomeAssistantService('script', 'reload');
      if (reloadResult.success) {
        message += '. Scripts reloaded.';
      } else {
        message += `. Scripts reload failed: ${reloadResult.error}`;
      }
    }

    res.json({ success: true, message, reloaded: message.includes('reloaded') });
  } catch (error) {
    console.error('[restore] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Restore all files in a commit
app.post('/api/restore-commit', async (req, res) => {
  try {
    const { sourceHash, targetHash, commitHash } = req.body;

    // Backward compatibility: if only commitHash provided, use it for both source and target
    const source = sourceHash || commitHash;
    const target = targetHash || commitHash;

    if (!source || !target) {
      return res.status(400).json({ success: false, error: 'sourceHash and targetHash (or commitHash) required' });
    }

    console.log(`[restore] Finding files from commit ${source.substring(0, 8)}`);
    console.log(`[restore] Restoring to version ${target.substring(0, 8)}`);

    // Get the list of files in the SOURCE commit using git show (files that were changed)
    const status = await gitRaw(['show', `${source}`, '--name-status', '--pretty=format:']);
    console.log(`[restore] Git show output:`, status);

    // Parse the output - each line is like "M\tfilename" or "A\tfilename"
    const lines = status.split('\n').filter(line => line.trim());
    const files = lines.map(line => {
      const parts = line.split('\t');
      return parts[1]; // Second column is the filename
    }).filter(f => f);

    console.log(`[restore] Found ${files.length} files from source commit:`, files);

    // Filter to only include config files based on configured extensions
    const allowedExtensions = getConfiguredExtensions();
    const configFiles = files.filter(file => {
      const hasAllowedExt = allowedExtensions.some(ext =>
        file.toLowerCase().endsWith(ext)
      );
      const isStorageFile = isConfiguredStorageRepoPath(file);
      return hasAllowedExt || isStorageFile;
    });

    if (configFiles.length !== files.length) {
      console.log(`[restore] Filtered to ${configFiles.length} config files (from ${files.length} total)`);
    }

    // If no config files found, try alternative method
    if (configFiles.length === 0) {
      console.log('[restore] No config files found with git show, trying git diff...');
      // As a fallback, get files changed in source commit vs its parent
      const diff = await gitDiff([`${source}^`, source, '--name-only']);
      const altFiles = diff.split('\n').filter(line => line.trim());
      console.log(`[restore] Found ${altFiles.length} files using diff:`, altFiles);

      // Filter these files too
      const filteredAltFiles = altFiles.filter(file => {
        const hasAllowedExt = allowedExtensions.some(ext =>
          file.toLowerCase().endsWith(ext)
        );
        const isStorageFile = isConfiguredStorageRepoPath(file);
        return hasAllowedExt || isStorageFile;
      });

      configFiles.push(...filteredAltFiles);
      console.log(`[restore] Filtered to ${filteredAltFiles.length} config files from diff`);
    }

    // Update files to the filtered list
    files.length = 0;
    files.push(...configFiles);

    // Restore each file to TARGET version - file watcher will detect and auto-commit all changes
    for (const file of files) {
      console.log(`[restore] Restoring ${file} to version ${target.substring(0, 8)}`);
      await restorePathToCommit(target, file);
    }

    console.log(`[restore] All files restored (${files.length} files)`);
    console.log(`[restore] File watcher will auto-commit these changes`);

    // Check if we need to reload automations or scripts in Home Assistant
    const needsAutomationReload = files.some(f => f.toLowerCase().includes('automations.yaml') || f.toLowerCase().includes('automations.yml'));
    const needsScriptReload = files.some(f => f.toLowerCase().includes('scripts.yaml') || f.toLowerCase().includes('scripts.yml'));

    let automationReloaded = false;
    let scriptReloaded = false;

    if (needsAutomationReload) {
      console.log('[restore] Reloading automations in Home Assistant...');
      const reloadResult = await callHomeAssistantService('automation', 'reload');
      automationReloaded = reloadResult.success;
    }

    if (needsScriptReload) {
      console.log('[restore] Reloading scripts in Home Assistant...');
      const reloadResult = await callHomeAssistantService('script', 'reload');
      scriptReloaded = reloadResult.success;
    }

    res.json({
      success: true,
      filesRestored: files.length,
      files: files,
      sourceHash: source.substring(0, 8),
      targetHash: target.substring(0, 8),
      commitHash: target.substring(0, 8), // For backward compatibility
      automationReloaded,
      scriptReloaded
    });
  } catch (error) {
    console.error('[restore] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Hard reset to a specific commit (resets ALL files, not just changed ones)
app.post('/api/git/hard-reset', async (req, res) => {
  try {
    const { commitHash, createBackup } = req.body;

    if (!commitHash) {
      return res.status(400).json({ success: false, error: 'commitHash is required' });
    }

    console.log(`[hard-reset] Resetting ALL files to commit ${commitHash.substring(0, 8)}`);

    // 1. Validate commit exists
    let commitExists;
    try {
      commitExists = await gitRaw(['cat-file', '-t', commitHash]);
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: `Commit ${commitHash.substring(0, 8)} not found`
      });
    }

    if (!commitExists.trim().startsWith('commit')) {
      return res.status(400).json({
        success: false,
        error: `Invalid commit: ${commitHash.substring(0, 8)}`
      });
    }

    let backupHash = null;

    // 2. Create safety backup if requested
    if (createBackup) {
      console.log('[hard-reset] Creating safety backup commit...');
      try {
        // Stage all current changes
        await gitAdd('.');

        // Check if there are changes to backup
        const status = await gitStatus();
        if (!status.isClean()) {
          // Create backup commit
          const timestamp = new Date().toISOString();
          const backupMessage = `Safety backup before hard reset to ${commitHash.substring(0, 8)} - ${timestamp}`;
          await gitCommit(backupMessage);

          // Get the backup commit hash
          const hashResult = await gitRaw(['rev-parse', 'HEAD']);
          backupHash = hashResult.trim();
          console.log(`[hard-reset] Safety backup created at ${backupHash.substring(0, 8)}`);
        } else {
          console.log('[hard-reset] No changes to backup (working directory clean)');
        }
      } catch (error) {
        console.error('[hard-reset] Backup creation failed:', error);
        return res.status(500).json({
          success: false,
          error: `Failed to create safety backup: ${error.message}`
        });
      }
    }

    // 3. Get list of all files in the target commit
    console.log(`[hard-reset] Getting file list from commit ${commitHash.substring(0, 8)}`);
    let filesInCommit;
    try {
      // Use git ls-tree to get all files in the commit
      const lsTree = await gitRaw(['ls-tree', '-r', '--name-only', commitHash]);
      filesInCommit = lsTree.trim().split('\n').filter(f => f);
      console.log(`[hard-reset] Found ${filesInCommit.length} files in target commit`);
    } catch (error) {
      console.error('[hard-reset] Failed to get file list:', error);
      return res.status(500).json({
        success: false,
        error: `Failed to get files from commit: ${error.message}`
      });
    }

    // 4. Checkout each file from the target commit
    console.log(`[hard-reset] Checking out ${filesInCommit.length} files from ${commitHash.substring(0, 8)}`);
    try {
      // Checkout all files
      for (const file of filesInCommit) {
        await restorePathToCommit(commitHash, file);
      }
      console.log(`[hard-reset] All files checked out from ${commitHash.substring(0, 8)}`);

      // Get the commit date for a better commit message
      let commitDate = '';
      try {
        const dateStr = (await gitRaw(['show', '-s', '--format=%aI', commitHash])).trim();
        const date = new Date(dateStr);
        commitDate = date.toLocaleString(undefined, {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          hour12: true
        }).replace(',', '');
      } catch (error) {
        console.error('[hard-reset] Failed to get commit date:', error);
        commitDate = commitHash.substring(0, 8);
      }

      // Auto-commit the changes
      await gitAdd('.');
      const statusAfter = await gitStatus();
      if (!statusAfter.isClean()) {
        const resetMessage = `Restored all files to ${commitDate}`;
        await gitCommit(resetMessage);
        console.log(`[hard-reset] Committed restored files`);
      }

      res.json({
        success: true,
        backupCommitHash: backupHash,
        resetToCommit: commitHash,
        filesRestored: filesInCommit.length,
        message: `Restored ${filesInCommit.length} files to commit ${commitHash.substring(0, 8)}${backupHash ? '. Safety backup created.' : ''}`
      });
    } catch (error) {
      console.error('[hard-reset] Checkout failed:', error);
      res.status(500).json({
        success: false,
        error: `File restoration failed: ${error.message}`
      });
    }

  } catch (error) {
    console.error('[hard-reset] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Soft reset to a specific commit (removes commits from history but keeps files unchanged)
app.post('/api/git/soft-reset', async (req, res) => {
  try {
    const { commitHash } = req.body;

    if (!commitHash) {
      return res.status(400).json({ success: false, error: 'commitHash is required' });
    }

    console.log(`[soft-reset] Soft resetting to commit ${commitHash.substring(0, 8)}`);

    // 1. Validate commit exists
    let commitExists;
    try {
      commitExists = await gitRaw(['cat-file', '-t', commitHash]);
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: `Commit ${commitHash.substring(0, 8)} not found`
      });
    }

    if (!commitExists.trim().startsWith('commit')) {
      return res.status(400).json({
        success: false,
        error: `Invalid commit: ${commitHash.substring(0, 8)}`
      });
    }

    // 2. Count how many commits will be removed
    let commitsToRemove = 0;
    try {
      const logOutput = await gitRaw(['log', '--oneline', `${commitHash}..HEAD`]);
      commitsToRemove = logOutput.trim().split('\n').filter(l => l).length;
    } catch (error) {
      // If this fails, we can still proceed
      console.log('[soft-reset] Could not count commits to remove:', error.message);
    }

    // 3. Perform soft reset
    try {
      // Log current HEAD before reset
      const headBefore = (await gitRaw(['rev-parse', 'HEAD'])).trim();
      console.log(`[soft-reset] HEAD before reset: ${headBefore.substring(0, 8)}`);

      await gitRaw(['reset', '--soft', commitHash]);
      console.log(`[soft-reset] Executed git reset --soft to ${commitHash.substring(0, 8)}`);

      // Verify HEAD actually changed
      const headAfter = (await gitRaw(['rev-parse', 'HEAD'])).trim();
      console.log(`[soft-reset] HEAD after reset: ${headAfter.substring(0, 8)}`);

      if (headBefore === headAfter) {
        console.error('[soft-reset] WARNING: HEAD did not change!');
      }

      // 4. Unstage all changes so file watcher doesn't immediately re-commit them
      // Soft reset stages all the changes from removed commits, which the file watcher 
      // would pick up and commit again. We need to unstage them.
      await gitRaw(['reset']);
      console.log('[soft-reset] Unstaged changes to prevent auto-re-commit');
    } catch (error) {
      console.error('[soft-reset] Reset failed:', error);
      return res.status(500).json({
        success: false,
        error: `Soft reset failed: ${error.message}`
      });
    }

    // 5. Get the commit date for the response
    let commitDate = '';
    try {
      const dateStr = (await gitRaw(['show', '-s', '--format=%aI', commitHash])).trim();
      const date = new Date(dateStr);
      commitDate = date.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
      }).replace(',', '');
    } catch (error) {
      commitDate = commitHash.substring(0, 8);
    }

    res.json({
      success: true,
      commitHash: commitHash.substring(0, 8),
      commitsRemoved: commitsToRemove,
      commitDate: commitDate,
      message: `Soft reset to ${commitDate}. ${commitsToRemove} commit(s) removed from history.`
    });

  } catch (error) {
    console.error('[soft-reset] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});


// Git status
// Manual commit endpoint
app.post('/api/git/commit-manual', async (req, res) => {
  try {
    const { message } = req.body;
    
    // Add all files - this respects .gitignore
    await gitAdd('.');
    
    // Check status to see if there are changes
    const status = await gitStatus();
    
    if (status.isClean()) {
      return res.json({ 
        success: true, 
        message: 'No changes to backup',
        committed: false
      });
    }
    
    // Use provided message or generate one
    const commitMessage = message || 'Manual mode control';
    
    await gitCommit(commitMessage);
    
    console.log(`[manual] Created commit: ${commitMessage}`);
    
    res.json({
      success: true,
      message: 'Backup created successfully',
      committed: true,
      commitMessage
    });
  } catch (error) {
    console.error('[manual-commit] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/git/status', async (req, res) => {
  try {
    const status = await gitStatus();
    res.json({ success: true, status });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// List YAML files (legacy)
app.post('/api/list-yaml-files', async (req, res) => {
  try {
    const { liveConfigPath, directory = '' } = req.body;
    const searchPath = liveConfigPath || CONFIG_PATH;
    const dirPath = directory ? `${searchPath}/${directory}` : searchPath;

    const allowedExtensions = getConfiguredExtensions();
    const files = fs.readdirSync(dirPath)
      .filter(f => {
        const matchesExtension = allowedExtensions.some(ext =>
          f.toLowerCase().endsWith(ext)
        );
        return matchesExtension;
      })
      .map(f => ({ name: f, path: f }));

    res.json({ success: true, files });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

function shouldIgnoreWatchPath(filePath) {
  if (!filePath) return true;

  // Normalize path separators to forward slashes for consistent matching
  const normalizedPath = filePath.replace(/\\/g, '/');

  // Ignore if path contains these directories (but not .storage for lovelace files)
  if (/(\/|^)\.(git|hg|svn|ssh|docker|ssl|keys|certs|node_modules)(\/|$)/.test(normalizedPath)) {
    return true;
  }

  // Ignore .storage files unless explicitly configured via include_storage
  if (normalizedPath.includes('/.storage/') && !isConfiguredStorageAbsolutePath(filePath)) {
    return true;
  }

  // Ignore database files and related files (very frequent writes)
  if (/\.(db|db-wal|db-shm|db-journal)$/.test(normalizedPath)) {
    return true;
  }

  // Ignore log files
  if (/\.log(\.\d+)?$/.test(normalizedPath) || normalizedPath.includes('/log/')) {
    return true;
  }

  // Ignore common binary and temporary files
  if (/\.(pyc|pyo|tmp|temp|bak|swp|swo)$/.test(normalizedPath)) {
    return true;
  }

  // Ignore zigbee2mqtt runtime files (state.json, database.db, logs)
  if (normalizedPath.includes('/zigbee2mqtt/') &&
    (normalizedPath.includes('/log/') || normalizedPath.endsWith('state.json') || normalizedPath.endsWith('database.db'))) {
    return true;
  }

  // Handle user-configured exclusions (#29)
  const hasExclusions = (runtimeSettings.extensions.exclude && runtimeSettings.extensions.exclude.length > 0) || 
                        (runtimeSettings.extensions.excludeFolders && runtimeSettings.extensions.excludeFolders.length > 0);

  if (hasExclusions) {
    // Convert absolute path to relative for prefix matching
    // Make sure we only match if it starts with CONFIG_PATH followed by a slash
    let relativePath = normalizedPath;
    if (normalizedPath === CONFIG_PATH) {
      relativePath = '';
    } else if (normalizedPath.startsWith(CONFIG_PATH + '/')) {
      relativePath = normalizedPath.substring(CONFIG_PATH.length + 1);
    }

    // Check exclude files/patterns
    if (runtimeSettings.extensions.exclude) {
      for (const excludePath of runtimeSettings.extensions.exclude) {
        const normalizedExclude = excludePath.replace(/\\/g, '/').replace(/\/$/, '');
        if (relativePath === normalizedExclude || relativePath.startsWith(normalizedExclude + '/')) {
          return true;
        }
      }
    }

    // Check exclude folders
    if (runtimeSettings.extensions.excludeFolders) {
      for (const excludeFolder of runtimeSettings.extensions.excludeFolders) {
        const normalizedExclude = excludeFolder.replace(/\\/g, '/').replace(/\/$/, '');
        if (relativePath === normalizedExclude || relativePath.startsWith(normalizedExclude + '/')) {
          return true;
        }
      }
    }
  }

  // Final safety check: deep path limit to prevent infinite loops from circular symlinks
  const configCount = (normalizedPath.match(/\/config\//g) || []).length;
  if (configCount > 3) {
    return true;
  }

  return false;
}

function initializeWatcher() {
  console.log(`[init] Initializing file watcher for: ${CONFIG_PATH}`);

  // Watch directory directly - let shouldIgnoreWatchPath handle filtering
  watcher = chokidar.watch(CONFIG_PATH, {
    persistent: true,
    ignoreInitial: true,
    depth: 15,
    followSymlinks: false,
    usePolling: runtimeSettings.watcherUsePolling,
    interval: runtimeSettings.watcherInterval,
    binaryInterval: runtimeSettings.watcherInterval,
    awaitWriteFinish: {
      stabilityThreshold: 2000,
      pollInterval: 100
    },
    ignored: (filePath, stats) => shouldIgnoreWatchPath(filePath)
  });

  // Handler function for both 'change' and 'add' events
  const handleFileEvent = async (filePath, eventType) => {
    // Check if the file should be ignored first to avoid starting Git operations
    if (shouldIgnoreWatchPath(filePath)) {
      if (runtimeSettings.debug) {
        const relPath = filePath.replace(CONFIG_PATH + '/', '');
        console.log(`[watcher] Ignoring ${eventType} event for: ${relPath} (matched exclusion rules)`);
      }
      return;
    }

    const relativePath = filePath.replace(CONFIG_PATH + '/', '');
    console.log(`[watcher] File ${eventType}: ${relativePath}`);

    // Clear any existing timer for this specific file
    if (debounceTimers.has(filePath)) {
      clearTimeout(debounceTimers.get(filePath));
    }

    // Set a new timer for this specific file
    const timer = setTimeout(async () => {
      try {
        // Ensure git is initialized
        if (!gitInitialized) {
          console.log('[watcher] Git not initialized yet, retrying...');
          await initRepo();
        }

        // No extension filtering here - let git's .gitignore handle what gets committed
        // The watcher triggers on any file change, git add . respects user's .gitignore

        // Check if this is only a formatting change (for YAML files)
        // Removed: We want to track ALL changes, including comments and formatting

        // Clear staging area to prevent accumulation of files from previous changes
        await gitRaw(['reset']);

        // Use git add . to stage all changes - git will respect user's .gitignore
        console.log(`[watcher] Triggered by: ${relativePath}, running git add .`);
        await gitAdd('.');

        // Check if there are actually changes to commit
        const status = await gitStatus();
        if (status.isClean()) {
          console.log(`[watcher] No changes to commit (repo is clean per .gitignore)`);
          debounceTimers.delete(filePath);
          return;
        }

        // Get all staged files (git already filtered based on .gitignore)
        const stagedFiles = status.files
          .filter(f => f.index !== ' ' && f.index !== '?')
          .map(f => f.path.trim());

        console.log(`[watcher] Staged files (respecting .gitignore): ${stagedFiles.join(', ')} (${stagedFiles.length} file(s))`);

        // Safety check: if no valid files to commit, clean up and return
        if (stagedFiles.length === 0) {
          console.log(`[watcher] No staged files to commit`);
          await gitRaw(['reset']);
          debounceTimers.delete(filePath);
          return;
        }

        // Create commit message based on number of files
        let commitMessage;
        if (stagedFiles.length === 1) {
          commitMessage = stagedFiles[0];
        } else if (stagedFiles.length === 2) {
          commitMessage = stagedFiles.join(', ');
        } else {
          commitMessage = `${stagedFiles.length} files`;
        }

        console.log(`[watcher] Committing: ${commitMessage} (${stagedFiles.length} file(s))`);
        await gitCommit(commitMessage);
        console.log(`Committed: ${commitMessage}`);

        // Run retention cleanup if enabled
        if (runtimeSettings.historyRetention) {
          console.log('[watcher] Running retention cleanup after commit...');
          await runRetentionCleanup();
        }

        // Cloud sync push if enabled and configured for every commit
        if (runtimeSettings.cloudSync.enabled &&
          runtimeSettings.cloudSync.pushFrequency === 'every_commit' &&
          runtimeSettings.cloudSync.remoteUrl) {
          console.log('[watcher] Running cloud sync push after commit...');
          try {
            await setupGitRemote(runtimeSettings.cloudSync.remoteUrl, runtimeSettings.cloudSync.authToken);
            await pushToRemote(runtimeSettings.cloudSync.includeSecrets);
          } catch (e) {
            console.error('[watcher] Cloud sync push failed:', e.message);
          }
        }

        // Clean up the timer reference
        debounceTimers.delete(filePath);
      } catch (error) {
        // Only log actual errors, not "nothing to commit" errors
        if (error.message && !error.message.includes('nothing to commit')) {
          console.error('[watcher] Auto-commit failed:', error.message);
          if (error.message.includes('Permission denied')) {
            console.error('[watcher] Permission denied - is the container running as root?');
            console.error('[watcher] The havc user needs write access to /config directory');
          }
        }
        // Clean up the timer reference even on error
        debounceTimers.delete(filePath);
      }
    }, getDebounceTimeMs());

    // Store the timer reference for this file
    debounceTimers.set(filePath, timer);
  };

  // Watch for file changes
  watcher.on('change', async (filePath) => {
    await handleFileEvent(filePath, 'changed');
  });

  // Watch for new files being added
  watcher.on('add', async (filePath) => {
    await handleFileEvent(filePath, 'added');
  });

  // Watch for files being deleted
  watcher.on('unlink', async (filePath) => {
    await handleFileEvent(filePath, 'deleted');
  });

  watcher.on('ready', () => {
    console.log('[init] File watcher ready and watching for changes');
  });

  watcher.on('error', error => {
    console.error('[watcher] Error:', error);
  });
}

async function handleExternalWatcherEvent(filePath, eventType) {
  const normalized = normalizeAbsolutePath(filePath);
  if (!normalized || !isPathInConfiguredAdditionalPaths(normalized)) {
    return;
  }

  try {
    if (eventType === 'deleted') {
      const removedPath = await removeMirrorFileForExternalPath(normalized);
      if (removedPath) {
        console.log(`[external-sync] Removed mirror for deleted file: ${normalized}`);
      }
      return;
    }

    const stats = await fsPromises.stat(normalized);
    if (!stats.isFile()) {
      return;
    }

    const mirroredPath = await syncExternalFileToMirror(normalized);
    if (mirroredPath) {
      console.log(`[external-sync] Synced ${eventType} file: ${normalized} -> ${mirroredPath}`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error(`[external-sync] Failed to process ${eventType} event for ${normalized}:`, error.message);
    }
  }
}

async function initializeExternalWatchers() {
  while (externalWatchers.length > 0) {
    const existingWatcher = externalWatchers.pop();
    try {
      await existingWatcher.close();
    } catch (error) {
      // Ignore close errors
    }
  }

  if (!additionalTrackedPaths.length) {
    return;
  }

  for (const additionalPath of additionalTrackedPaths) {
    try {
      await fsPromises.access(additionalPath, fs.constants.R_OK);
    } catch (error) {
      console.log(`[external-sync] Additional path not accessible, skipping watcher: ${additionalPath} (${error.code || 'ERROR'}: ${error.message})`);
      continue;
    }

    console.log(`[external-sync] Watching additional path: ${additionalPath}`);
    const externalWatcher = chokidar.watch(additionalPath, {
      persistent: true,
      ignoreInitial: true,
      depth: 15,
      followSymlinks: false,
      usePolling: runtimeSettings.watcherUsePolling,
      interval: runtimeSettings.watcherInterval,
      binaryInterval: runtimeSettings.watcherInterval,
      awaitWriteFinish: {
        stabilityThreshold: 2000,
        pollInterval: 100
      },
      ignored: (filePath, stats) => shouldIgnoreWatchPath(filePath)
    });

    externalWatcher.on('add', (filePath) => handleExternalWatcherEvent(filePath, 'added'));
    externalWatcher.on('change', (filePath) => handleExternalWatcherEvent(filePath, 'changed'));
    externalWatcher.on('unlink', (filePath) => handleExternalWatcherEvent(filePath, 'deleted'));
    externalWatcher.on('ready', () => console.log(`[external-sync] Watcher ready: ${additionalPath}`));
    externalWatcher.on('error', (error) => console.error(`[external-sync] Watcher error (${additionalPath}):`, error));

    externalWatchers.push(externalWatcher);
  }
}


// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    serverRunning: true,
    gitInitialized: gitInitialized || false,
    fileWatcherActive: watcher !== null,
    externalWatchersActive: externalWatchers.length,
    additionalTrackedPaths,
    watching: CONFIG_PATH || '/config',
    time: new Date().toISOString(),
    headers: req.headers,
    url: req.originalUrl,
    url: req.originalUrl
  });
});



// Advanced retention cleanup with custom parameters
app.post('/api/retention/cleanup', async (req, res) => {
  try {
    console.log('[api] Advanced retention cleanup triggered with options:', req.body);

    // Validate options
    const options = req.body || {};
    if (Object.keys(options).length === 0) {
      return res.status(400).json({ success: false, error: 'No retention options provided' });
    }

    // Run cleanup in background
    cleanupHistoryOrphanMethod(options)
      .then(result => console.log('[api] Advanced cleanup completed:', result))
      .catch(err => console.error('[api] Advanced cleanup failed:', err));

    res.json({ success: true, message: 'Cleanup started in background' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Manual retention cleanup
app.post('/api/run-retention', async (req, res) => {
  try {
    console.log('[api] Manual retention cleanup triggered');
    // Run cleanup in background to avoid timeout
    runRetentionCleanup(true).catch(err => console.error('[api] Background cleanup failed:', err));
    res.json({ success: true, message: 'Cleanup started in background' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Clean up old commits based on retention settings
 * This runs automatically when enabled in settings
 * @param {boolean} force - Force cleanup even if disabled in settings
 */
async function runRetentionCleanup(force = false) {
  if (!runtimeSettings.historyRetention && !force) {
    return; // Retention is disabled and not forced
  }

  const cleanupId = Date.now().toString().substring(8);
  console.log(`[retention-${cleanupId}] Running automatic cleanup...`);


  try {
    // Use the fixed cleanup method instead of the old buggy rebase logic
    // Convert retention settings to the format expected by cleanupHistoryOrphanMethod
    const options = {};

    if (runtimeSettings.retentionType === 'time') {
      // Convert the retention period to the appropriate time units
      const retentionMs = getRetentionPeriodMs();
      const retentionDays = Math.floor(retentionMs / (24 * 60 * 60 * 1000));
      const remainingMs = retentionMs % (24 * 60 * 60 * 1000);
      const retentionHours = Math.floor(remainingMs / (60 * 60 * 1000));
      const remainingMs2 = remainingMs % (60 * 60 * 1000);
      const retentionMinutes = Math.floor(remainingMs2 / (60 * 1000));
      const retentionSeconds = Math.floor((remainingMs2 % (60 * 1000)) / 1000);

      if (retentionDays > 0) options.days = retentionDays;
      if (retentionHours > 0) options.hours = retentionHours;
      if (retentionMinutes > 0) options.minutes = retentionMinutes;
      if (retentionSeconds > 0) options.seconds = retentionSeconds;

      // If no time units, default to 1 day
      if (Object.keys(options).length === 0) {
        options.days = 1;
      }

      console.log(`[retention-${cleanupId}] Time-based cleanup with options:`, options);
    } else if (runtimeSettings.retentionType === 'versions') {
      // For versions-based, we need to calculate how many days back to go
      // This is a limitation - we'll convert it to a time-based approach
      // by looking at the Nth commit and using its date
      console.log(`[retention-${cleanupId}] Versions-based retention not directly supported by cleanup API`);
      console.log(`[retention-${cleanupId}] Converting to time-based by examining commit dates...`);

      const retentionValue = parseInt(runtimeSettings.retentionValue);
      const log = await getLightweightGitLog();

      if (log.all.length > retentionValue) {
        // Find the date of the Nth commit from HEAD
        const cutoffCommit = log.all[retentionValue - 1];
        const cutoffDate = new Date(cutoffCommit.date);
        const ageMs = Date.now() - cutoffDate.getTime();

        // Convert to days/hours/minutes
        const days = Math.floor(ageMs / (24 * 60 * 60 * 1000));
        const hours = Math.floor((ageMs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
        const minutes = Math.floor((ageMs % (60 * 60 * 1000)) / (60 * 1000));

        if (days > 0) options.days = days;
        if (hours > 0) options.hours = hours;
        if (minutes > 0) options.minutes = minutes;

        console.log(`[retention-${cleanupId}] Keeping ${retentionValue} commits = keeping last ${days}d ${hours}h ${minutes}m`);
      } else {
        console.log(`[retention-${cleanupId}] Only ${log.all.length} commits exist, wanted to keep ${retentionValue}. No cleanup needed.`);
        return;
      }
    }

    // Call the fixed cleanup method
    const result = await cleanupHistoryOrphanMethod(options);

    if (result.success) {
      console.log(`[retention-${cleanupId}] Cleanup successful: ${result.message}`);
      console.log(`[retention-${cleanupId}] Merged: ${result.commitsMerged}, Kept: ${result.commitsKept}, Total: ${result.totalCommits}`);
    }

  } catch (error) {
    console.error(`[retention-${cleanupId}] Cleanup failed:`, error.message);
  }
}

/**
 * Clean up old commits using orphan branch method
 * @param {Object} options - Cleanup options
 * @param {number} options.months - Number of months of history to keep (approx 30 days)
 * @param {number} options.weeks - Number of weeks of history to keep
 * @param {number} options.days - Number of days of history to keep
 * @param {number} options.hours - Number of hours of history to keep
 * @param {number} options.minutes - Number of minutes of history to keep
 * @param {number} options.seconds - Number of seconds of history to keep
 * @returns {Object} Cleanup results
 */
async function cleanupHistoryOrphanMethod(options) {
  if (!gitInitialized) {
    throw new Error('Git repository not initialized');
  }

  if (cleanupLock) {
    throw new Error('Cleanup already in progress');
  }

  cleanupLock = true;

  // Ensure working directory is clean before starting rebase-based cleanup
  try {
    const status = await gitStatus();
    if (!status.isClean()) {
      console.log('[retention] Working directory is dirty. Attempting to auto-commit changes before cleanup...');

      // Add files matching configured patterns only (not all files)
      const extensions = getConfiguredExtensions();
      const patterns = extensions.map(ext => `**/*${ext}`);
      const storagePatterns = getConfiguredStoragePatterns().map(pattern => `.storage/${pattern}`);
      patterns.push(...storagePatterns);

      for (const pattern of patterns) {
        try {
          await gitRaw(['add', pattern]);
        } catch (err) {
          // Pattern may not match any files, which is fine
          console.log(`[retention] Pattern ${pattern} matched no files (expected)`);
        }
      }

      // Get the updated status with staged files
      const updatedStatus = await gitStatus();

      // Get all staged files and filter to only include allowed patterns
      const allStagedFiles = updatedStatus.files
        .filter(f => f.index !== ' ' && f.index !== '?');

      // Filter out any files that shouldn't be tracked
      const stagedFiles = allStagedFiles
        .filter(f => {
          const filePath = f.path.trim(); // Trim to remove leading/trailing spaces from git status
          const hasAllowedExt = getConfiguredExtensions().some(ext => filePath.endsWith(ext));
          const isStorageFile = isConfiguredStorageRepoPath(filePath);
          return hasAllowedExt || isStorageFile;
        })
        .map(f => f.path.trim()); // Also trim when extracting the path

      // If no valid files to commit, reset and continue
      if (stagedFiles.length === 0) {
        console.log('[retention] No valid files to commit after filtering, continuing with cleanup');
        await gitRaw(['reset']);
        cleanupLock = false;
        return {
          success: true,
          message: 'No changes to commit (all files filtered out)',
          commitsMerged: 0,
          commitsKept: 0
        };
      }

      // Create commit message based on number of files (same logic as file watcher)
      let commitMessage;
      if (stagedFiles.length === 1) {
        commitMessage = stagedFiles[0];
      } else if (stagedFiles.length === 2) {
        commitMessage = stagedFiles.join(', ');
      } else if (stagedFiles.length > 0) {
        commitMessage = `${stagedFiles.length} files`;
      } else {
        commitMessage = 'Pre-cleanup changes';
      }

      await gitCommit(commitMessage);
      console.log(`[retention] Created pre-cleanup commit: ${commitMessage}`);
    }
  } catch (error) {
    console.error('[retention] Failed to ensure clean working directory:', error.message);
    cleanupLock = false;
    throw new Error(`Cannot start cleanup: Working directory is dirty and auto-commit failed: ${error.message}`);
  }

  // Calculate total milliseconds from all time units
  let totalMs = 0;
  let timeDescription = [];

  if (options.months) {
    totalMs += options.months * 30 * 24 * 60 * 60 * 1000; // Approx 30 days
    timeDescription.push(`${options.months} month${options.months !== 1 ? 's' : ''}`);
  }
  if (options.weeks) {
    totalMs += options.weeks * 7 * 24 * 60 * 60 * 1000;
    timeDescription.push(`${options.weeks} week${options.weeks !== 1 ? 's' : ''}`);
  }
  if (options.days) {
    totalMs += options.days * 24 * 60 * 60 * 1000;
    timeDescription.push(`${options.days} day${options.days !== 1 ? 's' : ''}`);
  }
  if (options.hours) {
    totalMs += options.hours * 60 * 60 * 1000;
    timeDescription.push(`${options.hours} hour${options.hours !== 1 ? 's' : ''}`);
  }
  if (options.minutes) {
    totalMs += options.minutes * 60 * 1000;
    timeDescription.push(`${options.minutes} minute${options.minutes !== 1 ? 's' : ''}`);
  }
  if (options.seconds) {
    totalMs += options.seconds * 1000;
    timeDescription.push(`${options.seconds} second${options.seconds !== 1 ? 's' : ''}`);
  }

  const timeDesc = timeDescription.join(', ');
  console.log(`[retention] Starting cleanup - keeping last ${timeDesc}`);

  try {
    // Calculate cutoff date
    const cutoffDate = new Date(Date.now() - totalMs);
    console.log(`[retention] Cutoff date: ${cutoffDate.toISOString()}`);

    // Get current branch name
    const currentBranch = (await gitRevparse(['--abbrev-ref', 'HEAD'])).trim();
    console.log(`[retention] Current branch: ${currentBranch}`);

    // Get all commits
    const log = await getLightweightGitLog();
    const allCommits = log.all;
    console.log(`[retention] Total commits before cleanup: ${allCommits.length}`);

    if (allCommits.length === 0) {
      return {
        success: true,
        message: 'No commits to clean up',
        commitsRemoved: 0,
        commitsKept: 0
      };
    }

    // Filter commits (allCommits is ordered newest to oldest)
    // CRITICAL FIX: Use a split point to ensure contiguous history
    // Instead of filtering independently, find the first commit that is too old
    // and merge everything from there down. This prevents gaps if child is older than parent.
    let splitIndex = allCommits.findIndex(commit => {
      const commitDate = new Date(commit.date);
      return commitDate <= cutoffDate;
    });

    // If no commits are old enough to merge, return
    if (splitIndex === -1) {
      return {
        success: true,
        message: 'All commits are within retention period',
        commitsRemoved: 0,
        commitsKept: allCommits.length,
        oldestCommitDate: allCommits.length > 0 ? new Date(allCommits[allCommits.length - 1].date).toISOString() : null
      };
    }

    const commitsToKeep = allCommits.slice(0, splitIndex);
    const commitsToMerge = allCommits.slice(splitIndex);

    console.log(`[retention] Commits to merge (older than cutoff): ${commitsToMerge.length}`);
    console.log(`[retention] Commits to keep (newer than cutoff): ${commitsToKeep.length}`);

    if (commitsToMerge.length > 0) {
      console.log(`[retention] Date range of commits to merge: ${new Date(commitsToMerge[commitsToMerge.length - 1].date).toISOString()} to ${new Date(commitsToMerge[0].date).toISOString()}`);
    }
    if (commitsToKeep.length > 0) {
      console.log(`[retention] Date range of commits to keep: ${new Date(commitsToKeep[commitsToKeep.length - 1].date).toISOString()} to ${new Date(commitsToKeep[0].date).toISOString()}`);
    }

    // Safety check: if we are keeping everything, do nothing
    if (commitsToMerge.length === 0) {
      return {
        success: true,
        message: 'All commits are within retention period',
        commitsRemoved: 0,
        commitsKept: allCommits.length,
        oldestCommitDate: allCommits.length > 0 ? allCommits[allCommits.length - 1].date : new Date().toISOString()
      };
    }

    // Safety check: if we are removing everything, keep at least the latest commit
    if (commitsToKeep.length === 0) {
      console.log('[retention] Safety check: Would remove all commits. Keeping the most recent commit.');
      commitsToKeep.push(allCommits[0]);
      // Remove the kept commit from merge list
      const index = commitsToMerge.findIndex(c => c.hash === allCommits[0].hash);
      if (index !== -1) commitsToMerge.splice(index, 1);
    }

    // Create a backup branch just in case
    const backupBranch = `backup-before-cleanup-${Date.now()}`;
    console.log(`[retention] Creating backup branch: ${backupBranch}`);
    await gitBranch([backupBranch]);

    // Get the tree hash from the last commit we're merging
    // This represents the state of the repo at the cutoff point
    const oldestKeptCommit = commitsToKeep[commitsToKeep.length - 1];
    const newestMergedCommit = commitsToMerge[0];

    // Handle case where we merge EVERYTHING (commitsToKeep is empty)
    if (commitsToKeep.length === 0) {
      console.log('[retention] All commits are older than cutoff - merging everything into one baseline');

      // Create baseline commit pointing to HEAD's tree
      const headCommit = allCommits[0];
      const baselineTreeHash = (await gitRaw(['rev-parse', `${headCommit.hash}^{tree}`])).trim();

      // Use HEAD's date for the baseline
      const baselineDateISO = headCommit.date;

      // Format date for message
      const baselineMessage = `Merged history ${baselineDateISO}`;

      const { stdout: baselineCommitHashOut } = await gitExec(
        ['commit-tree', baselineTreeHash, '-m', baselineMessage],
        { env: { ...process.env, GIT_AUTHOR_DATE: baselineDateISO, GIT_COMMITTER_DATE: baselineDateISO } }
      );
      const baselineCommitHash = baselineCommitHashOut.trim();

      // Reset branch to this new baseline
      await gitRaw(['reset', '--hard', baselineCommitHash]);

      // Cleanup
      await gitRaw(['reflog', 'expire', '--expire=now', '--all']);
      await gitRaw(['gc', '--prune=now']);

      return {
        success: true,
        message: 'History cleanup completed (all commits merged)',
        commitsMerged: allCommits.length,
        commitsKept: 0,
        totalCommits: 1,
        backupBranch,
        baselineCommit: baselineCommitHash.substring(0, 8),
        oldestCommitDate: baselineDateISO
      };
    }

    // Normal case: We have some commits to keep and some to merge
    // Get the tree from the newest commit to be merged (the one right before oldest kept)
    let baselineTreeHash = (await gitRaw(['rev-parse', `${newestMergedCommit.hash}^{tree}`])).trim();

    console.log(`[retention] Will merge ${commitsToMerge.length} commits into baseline`);
    console.log(`[retention] Using tree from commit: ${newestMergedCommit.hash.substring(0, 8)}`);

    // Create the baseline commit message
    // CRITICAL FIX: Use the OLDEST merged commit date so baseline appears at BOTTOM of timeline
    const oldestMergedDate = commitsToMerge[commitsToMerge.length - 1].date;
    const newestMergedDate = commitsToMerge[0].date;

    // Debug: log all merged commit dates to verify ordering
    console.log(`[retention] Merged commits date range:`);
    console.log(`[retention]   Oldest (last in array): ${oldestMergedDate}`);
    console.log(`[retention]   Newest (first in array): ${newestMergedDate}`);
    if (commitsToMerge.length > 2) {
      console.log(`[retention]   All ${commitsToMerge.length} merged commit dates:`);
      commitsToMerge.forEach((c, i) => {
        console.log(`[retention]     [${i}] ${c.date} - ${c.message.split('\n')[0].substring(0, 50)}`);
      });
    }

    // Set baseline date to the newest merged commit date (youngest merged commit)
    // This ensures the commit timestamp reflects the most recent change included in the merge
    const baselineDateISO = newestMergedDate;

    const baselineMessage = `Merged history ${oldestMergedDate}`;

    console.log(`[retention] Creating baseline commit...`);
    console.log(`[retention] Baseline date: ${baselineDateISO} (1 second before oldest merged commit)`);
    console.log(`[retention] This ensures baseline appears at the BOTTOM of the timeline`);

    // Create the baseline commit with NO parents (making it a root/orphan commit)
    const { stdout: baselineCommitHashOut } = await gitExec(
      ['commit-tree', baselineTreeHash, '-m', baselineMessage],
      { env: { ...process.env, GIT_AUTHOR_DATE: baselineDateISO, GIT_COMMITTER_DATE: baselineDateISO } }
    );
    const baselineCommitHash = baselineCommitHashOut.trim();

    console.log(`[retention] Created baseline commit: ${baselineCommitHash.substring(0, 8)}`);

    // Now we need to replay ONLY the kept commits on top of this baseline
    // Strategy: Use git rebase --onto to replay commits from oldestKeptCommit onwards

    // Get the parent of the oldest kept commit (if it exists)
    // This is the "upstream" - we want to replay everything AFTER this
    let upstreamCommit;
    if (oldestKeptCommit.parents && oldestKeptCommit.parents.length > 0) {
      upstreamCommit = oldestKeptCommit.parents[0];
    } else {
      // If oldest kept commit has no parent, it's already the root
      // In this case, we can't use rebase, we just update the branch
      console.log('[retention] Oldest kept commit has no parent - this should not happen due to safety checks');
      throw new Error('Unexpected state: oldest kept commit has no parent');
    }

    console.log(`[retention] Rebasing kept commits onto baseline...`);
    console.log(`[retention] Replaying commits AFTER ${upstreamCommit.substring(0, 8)} onto ${baselineCommitHash.substring(0, 8)}`);

    // git rebase --onto <newbase> <upstream> <branch>
    // This will take all commits from <upstream>..<branch> and replay them onto <newbase>
    await gitRaw(['rebase', '--onto', baselineCommitHash, upstreamCommit, currentBranch]);

    console.log('[retention] Rebase successful!');

    // Clean up unreachable objects (the old merged commits)
    console.log('[retention] Cleaning up unreachable objects...');
    await gitRaw(['reflog', 'expire', '--expire=now', '--all']);
    await gitRaw(['gc', '--prune=now']);

    // Verify the result
    const logAfter = await getLightweightGitLog();
    const expectedTotal = commitsToKeep.length + 1; // kept commits + baseline

    console.log(`[retention] Cleanup complete!`);
    console.log(`[retention] Expected commits: ${expectedTotal} (${commitsToKeep.length} kept + 1 baseline)`);
    console.log(`[retention] Actual commits: ${logAfter.total}`);
    if (logAfter.all.length > 0) {
      const oldestAfter = logAfter.all[logAfter.all.length - 1];
      const newestAfter = logAfter.all[0];
      console.log(`[retention] Oldest commit: ${oldestAfter.hash.substring(0, 8)} - ${new Date(oldestAfter.date).toISOString()} - "${oldestAfter.message.substring(0, 50)}"`);
      console.log(`[retention] Newest commit: ${newestAfter.hash.substring(0, 8)} - ${new Date(newestAfter.date).toISOString()}`);
    }

    // Get new stats
    const newLog = await getLightweightGitLog();

    return {
      success: true,
      message: `History cleanup completed. Merged ${commitsToMerge.length} old commits.`,
      commitsMerged: commitsToMerge.length,
      commitsKept: commitsToKeep.length,
      totalCommits: newLog.total,
      backupBranch,
      baselineCommit: baselineCommitHash.substring(0, 8),
      oldestCommitDate: baselineDateISO
    };

  } catch (error) {
    console.error('[retention] Cleanup failed:', error);

    // Attempt recovery
    try {
      console.log('[retention] Attempting to abort rebase...');
      await gitRaw(['rebase', '--abort']);
    } catch (e) {
      // Ignore if no rebase in progress
      console.log('[retention] No rebase to abort or abort failed');
    }

    throw error;
  } finally {
    cleanupLock = false;
  }
}

/**
 * Preview what would be deleted without actually deleting
 * @param {Object} options - Preview options
 * @param {number} options.months - Number of months of history to keep
 * @param {number} options.weeks - Number of weeks of history to keep
 * @param {number} options.days - Number of days of history to keep
 * @param {number} options.hours - Number of hours of history to keep
 * @param {number} options.minutes - Number of minutes of history to keep
 * @param {number} options.seconds - Number of seconds of history to keep
 * @returns {Object} Preview results
 */
async function previewHistoryCleanup(options) {
  if (!gitInitialized) {
    throw new Error('Git repository not initialized');
  }

  // Calculate total milliseconds from all time units
  let totalMs = 0;
  let timeDescription = [];

  if (options.months) {
    totalMs += options.months * 30 * 24 * 60 * 60 * 1000; // Approx 30 days
    timeDescription.push(`${options.months} month${options.months !== 1 ? 's' : ''}`);
  }
  if (options.weeks) {
    totalMs += options.weeks * 7 * 24 * 60 * 60 * 1000;
    timeDescription.push(`${options.weeks} week${options.weeks !== 1 ? 's' : ''}`);
  }
  if (options.days) {
    totalMs += options.days * 24 * 60 * 60 * 1000;
    timeDescription.push(`${options.days} day${options.days !== 1 ? 's' : ''}`);
  }
  if (options.hours) {
    totalMs += options.hours * 60 * 60 * 1000;
    timeDescription.push(`${options.hours} hour${options.hours !== 1 ? 's' : ''}`);
  }
  if (options.minutes) {
    totalMs += options.minutes * 60 * 1000;
    timeDescription.push(`${options.minutes} minute${options.minutes !== 1 ? 's' : ''}`);
  }
  if (options.seconds) {
    totalMs += options.seconds * 1000;
    timeDescription.push(`${options.seconds} second${options.seconds !== 1 ? 's' : ''}`);
  }

  const timeDesc = timeDescription.join(', ');
  console.log(`[retention-preview] Previewing cleanup - keeping last ${timeDesc}`);

  const cutoffDate = new Date(Date.now() - totalMs);
  const log = await getLightweightGitLog();
  const allCommits = log.all;

  const commitsToKeep = allCommits.filter(commit => {
    const commitDate = new Date(commit.date);
    return commitDate > cutoffDate;
  });

  const commitsToRemove = allCommits.filter(commit => {
    const commitDate = new Date(commit.date);
    return commitDate <= cutoffDate;
  });

  return {
    success: true,
    totalCommits: allCommits.length,
    commitsToKeep: commitsToKeep.length,
    commitsToRemove: commitsToRemove.length,
    cutoffDate: cutoffDate.toISOString(),
    oldestCommit: allCommits.length > 0 ? {
      hash: allCommits[allCommits.length - 1].hash.substring(0, 8),
      date: new Date(allCommits[allCommits.length - 1].date).toISOString(),
      message: allCommits[allCommits.length - 1].message
    } : null,
    oldestKeptCommit: commitsToKeep.length > 0 ? {
      hash: commitsToKeep[commitsToKeep.length - 1].hash.substring(0, 8),
      date: new Date(commitsToKeep[commitsToKeep.length - 1].date).toISOString(),
      message: commitsToKeep[commitsToKeep.length - 1].message
    } : null,
    commitsToRemoveList: commitsToRemove.slice(0, 10).map(c => ({
      hash: c.hash.substring(0, 8),
      date: new Date(c.date).toISOString(),
      message: c.message
    }))
  };
}

// API endpoint: Preview cleanup (dry-run)
app.post('/api/retention/preview', async (req, res) => {
  try {
    const { months, weeks, days, hours, minutes, seconds } = req.body;

    // Validate that at least one time unit is provided
    if (!months && !weeks && !days && !hours && !minutes && !seconds) {
      return res.status(400).json({
        success: false,
        error: 'At least one time parameter (months, weeks, days, hours, minutes, or seconds) must be provided.'
      });
    }

    // Validate that all provided values are positive numbers
    if ((months && months <= 0) || (weeks && weeks <= 0) || (days && days <= 0) || (hours && hours <= 0) || (minutes && minutes <= 0) || (seconds && seconds <= 0)) {
      return res.status(400).json({
        success: false,
        error: 'All time parameters must be positive numbers.'
      });
    }

    console.log(`[retention-api] Preview requested for ${months || 0}mo ${weeks || 0}w ${days || 0}d ${hours || 0}h ${minutes || 0}m ${seconds || 0}s`);
    const preview = await previewHistoryCleanup({ months, weeks, days, hours, minutes, seconds });

    res.json(preview);
  } catch (error) {
    console.error('[retention-api] Preview failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// API endpoint: Execute cleanup
app.post('/api/retention/cleanup', async (req, res) => {
  try {
    const { months, weeks, days, hours, minutes, seconds } = req.body;

    // Validate that at least one time unit is provided
    if (!months && !weeks && !days && !hours && !minutes && !seconds) {
      return res.status(400).json({
        success: false,
        error: 'At least one time parameter (months, weeks, days, hours, minutes, or seconds) must be provided.'
      });
    }

    // Validate that all provided values are positive numbers
    if ((months && months <= 0) || (weeks && weeks <= 0) || (days && days <= 0) || (hours && hours <= 0) || (minutes && minutes <= 0) || (seconds && seconds <= 0)) {
      return res.status(400).json({
        success: false,
        error: 'All time parameters must be positive numbers.'
      });
    }

    console.log(`[retention-api] Cleanup requested for ${months || 0}mo ${weeks || 0}w ${days || 0}d ${hours || 0}h ${minutes || 0}m ${seconds || 0}s`);
    const result = await cleanupHistoryOrphanMethod({ months, weeks, days, hours, minutes, seconds });

    res.json(result);
  } catch (error) {
    console.error('[retention-api] Cleanup failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// API endpoint: Get retention status/statistics
app.get('/api/retention/status', async (req, res) => {
  try {
    if (!gitInitialized) {
      return res.json({
        success: false,
        error: 'Git repository not initialized'
      });
    }

    const log = await gitLog();
    const allCommits = log.all;

    if (allCommits.length === 0) {
      return res.json({
        success: true,
        totalCommits: 0,
        oldestCommit: null,
        newestCommit: null,
        repositoryAge: null
      });
    }

    const oldestCommit = allCommits[allCommits.length - 1];
    const newestCommit = allCommits[0];
    const oldestDate = new Date(oldestCommit.date);
    const newestDate = new Date(newestCommit.date);
    const ageInHours = (newestDate - oldestDate) / (1000 * 60 * 60);

    res.json({
      success: true,
      totalCommits: allCommits.length,
      oldestCommit: {
        hash: oldestCommit.hash.substring(0, 8),
        date: oldestDate.toISOString(),
        message: oldestCommit.message
      },
      newestCommit: {
        hash: newestCommit.hash.substring(0, 8),
        date: newestDate.toISOString(),
        message: newestCommit.message
      },
      repositoryAge: {
        hours: Math.round(ageInHours),
        days: Math.round(ageInHours / 24),
        weeks: Math.round(ageInHours / (24 * 7))
      }
    });
  } catch (error) {
    console.error('[retention-api] Status check failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Debug endpoint to check ingress path detection
app.get('/api/debug', (req, res) => {
  res.json({
    originalUrl: req.originalUrl,
    url: req.url,
    headers: req.headers,
    ingressPath: req.headers['x-ingress-path'] ||
      req.headers['x-forwarded-prefix'] ||
      req.headers['x-external-url'] ||
      '(not set)'
  });
});

const server = app.listen(PORT, HOST, (err) => {
  if (err) {
    console.error('[init] Failed to start server:', err);
    process.exit(1);
  }

  console.log('='.repeat(60));
  console.log('Home Assistant Version Control v1.2.0');
  console.log('='.repeat(60));
  console.log(`Server running at http://${HOST}:${PORT}`);

  // Run initialization in background to avoid blocking server startup
  initRepo()
    .then(() => {
      if (!runtimeSettings.manualMode) {
        initializeWatcher();
        initializeExternalWatchers().catch((error) => {
          console.error('[external-sync] Failed to initialize external watchers:', error);
        });
      } else {
        console.log('[init] Manual mode active: skipping file watcher initialization');
      }

      // Start cloud sync scheduler (check every hour)
      startCloudSyncScheduler();
    })
    .catch((error) => {
      console.error('[init] Background initialization error:', error);
    });
});

// Cloud sync scheduler - checks if push is due
let cloudSyncInterval = null;

function startCloudSyncScheduler() {
  // Check every hour if a scheduled push is due
  cloudSyncInterval = setInterval(async () => {
    try {
      const settings = runtimeSettings.cloudSync;

      // Skip if not enabled or manual mode
      if (!settings.enabled || !settings.remoteUrl || settings.pushFrequency === 'manual' || settings.pushFrequency === 'every_commit') {
        return;
      }

      const now = new Date();
      const lastPush = settings.lastPushTime ? new Date(settings.lastPushTime) : null;

      let shouldPush = false;

      if (!lastPush) {
        // Never pushed, do it now
        shouldPush = true;
      } else if (settings.pushFrequency === 'hourly') {
        // Push if more than 1 hour since last push
        shouldPush = (now - lastPush) >= 60 * 60 * 1000;
      } else if (settings.pushFrequency === 'daily') {
        // Push if more than 24 hours since last push
        shouldPush = (now - lastPush) >= 24 * 60 * 60 * 1000;
      }

      if (shouldPush) {
        console.log(`[cloud-sync scheduler] Running ${settings.pushFrequency} push...`);
        await setupGitRemote(settings.remoteUrl, settings.authToken);
        await pushToRemote(settings.includeSecrets);
      }
    } catch (error) {
      console.error('[cloud-sync scheduler] Error:', error.message);
    }
  }, 60 * 60 * 1000); // Check every hour

  console.log('[cloud-sync] Scheduler started (checking hourly for scheduled pushes)');
}

// Get all automations
app.get('/api/automations', async (req, res) => {
  try {
    const automations = await extractAutomations(CONFIG_PATH);
    res.json({ success: true, automations });
  } catch (error) {
    console.error('[automations] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get all scripts
app.get('/api/scripts', async (req, res) => {
  try {
    const scripts = await extractScripts(CONFIG_PATH);
    res.json({ success: true, scripts });
  } catch (error) {
    console.error('[scripts] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get automation history
app.get('/api/automation/:id/history', async (req, res) => {
  try {
    const { id } = req.params;
    const options = {};
    if (runtimeSettings.limitHistory) {
      options.maxCount = runtimeSettings.maxCommits;
    }
    const { success, history, debugMessages } = await getAutomationHistory(id, CONFIG_PATH, options);
    res.json({ success, history, debugMessages });
  } catch (error) {
    console.error('[automation history] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get script history
app.get('/api/script/:id/history', async (req, res) => {
  try {
    const { id } = req.params;
    const options = {};
    if (runtimeSettings.limitHistory) {
      options.maxCount = runtimeSettings.maxCommits;
    }
    const { success, history, debugMessages } = await getScriptHistory(id, CONFIG_PATH, options);
    res.json({ success, history, debugMessages });
  } catch (error) {
    console.error('[script history] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Progressive loading: Get automation history metadata (fast - no YAML parsing)
app.get('/api/automation/:id/history-metadata', async (req, res) => {
  try {
    const { id } = req.params;
    const options = {};
    if (runtimeSettings.limitHistory) {
      options.maxCount = runtimeSettings.maxCommits;
    }
    const result = await getAutomationHistoryMetadata(id, CONFIG_PATH, options);
    res.json(result);
  } catch (error) {
    console.error('[automation history-metadata] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Progressive loading: Get automation content at specific commit
app.get('/api/automation/:id/at-commit', async (req, res) => {
  try {
    const { id } = req.params;
    const { commitHash } = req.query;
    if (!commitHash) {
      return res.status(400).json({ success: false, error: 'commitHash is required' });
    }
    const result = await getAutomationAtCommit(id, commitHash, CONFIG_PATH);
    res.json(result);
  } catch (error) {
    console.error('[automation at-commit] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Progressive loading: Get script history metadata (fast - no YAML parsing)
app.get('/api/script/:id/history-metadata', async (req, res) => {
  try {
    const { id } = req.params;
    const options = {};
    if (runtimeSettings.limitHistory) {
      options.maxCount = runtimeSettings.maxCommits;
    }
    const result = await getScriptHistoryMetadata(id, CONFIG_PATH, options);
    res.json(result);
  } catch (error) {
    console.error('[script history-metadata] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Progressive loading: Get script content at specific commit
app.get('/api/script/:id/at-commit', async (req, res) => {
  try {
    const { id } = req.params;
    const { commitHash } = req.query;
    if (!commitHash) {
      return res.status(400).json({ success: false, error: 'commitHash is required' });
    }
    const result = await getScriptAtCommit(id, commitHash, CONFIG_PATH);
    res.json(result);
  } catch (error) {
    console.error('[script at-commit] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get automation diff
app.get('/api/automation/:id/diff', async (req, res) => {
  try {
    const { id } = req.params;
    const { commitHash } = req.query;
    const diff = await getAutomationDiff(id, commitHash, CONFIG_PATH);
    res.json({ success: true, diff });
  } catch (error) {
    console.error('[automation diff] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get script diff
app.get('/api/script/:id/diff', async (req, res) => {
  try {
    const { id } = req.params;
    const { commitHash } = req.query;
    const diff = await getScriptDiff(id, commitHash, CONFIG_PATH);
    res.json({ success: true, diff });
  } catch (error) {
    console.error('[script diff] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Restore automation
app.post('/api/automation/:id/restore', async (req, res) => {
  try {
    const { id } = req.params;
    const { commitHash } = req.body;
    const success = await restoreAutomation(id, commitHash, CONFIG_PATH);

    if (success) {
      // Automatically reload automations in Home Assistant
      console.log('[restore automation] Reloading automations in Home Assistant...');
      const reloadResult = await callHomeAssistantService('automation', 'reload');

      if (reloadResult.success) {
        res.json({ success: true, message: 'Automation restored and reloaded in Home Assistant', reloaded: true });
      } else {
        res.json({ success: true, message: 'Automation restored but reload failed: ' + reloadResult.error });
      }
    } else {
      res.json({ success: false, message: 'Failed to restore automation' });
    }
  } catch (error) {
    console.error('[restore automation] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Restore script
app.post('/api/script/:id/restore', async (req, res) => {
  try {
    const { id } = req.params;
    const { commitHash } = req.body;
    const success = await restoreScript(id, commitHash, CONFIG_PATH);

    if (success) {
      // Automatically reload scripts in Home Assistant
      console.log('[restore script] Reloading scripts in Home Assistant...');
      const reloadResult = await callHomeAssistantService('script', 'reload');

      if (reloadResult.success) {
        res.json({ success: true, message: 'Script restored and reloaded in Home Assistant', reloaded: true });
      } else {
        res.json({ success: true, message: 'Script restored but reload failed: ' + reloadResult.error });
      }
    } else {
      res.json({ success: false, message: 'Failed to restore script' });
    }
  } catch (error) {
    console.error('[restore script] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// =====================================
// Cloud Sync Functions
// =====================================

/**
 * Set up or update the git remote for cloud sync
 * @param {string} url - Remote repository URL
 * @param {string} token - Authentication token
 * @returns {Object} Result with success status
 */
async function setupGitRemote(url, token) {
  try {
    let authenticatedUrl = url;

    // Check if URL already has credentials embedded (user@host pattern)
    const hasEmbeddedAuth = url.match(/:\/\/[^@]+@/);

    if (!hasEmbeddedAuth && token) {
      // Insert token into URL for HTTPS or HTTP URLs
      if (url.startsWith('https://')) {
        authenticatedUrl = url.replace('https://', `https://${token}@`);
      } else if (url.startsWith('http://')) {
        authenticatedUrl = url.replace('http://', `http://${token}@`);
      }
    }

    // Log the URL being used (mask any token for security)
    const maskedUrl = authenticatedUrl.replace(/:\/\/([^@]+)@/, '://***@');
    console.log('[cloud-sync] Setting up remote with URL:', maskedUrl);

    // Check if origin remote exists
    try {
      await gitExec(['remote', 'get-url', 'origin']);
      // Remote exists, update it
      await gitExec(['remote', 'set-url', 'origin', authenticatedUrl]);
      console.log('[cloud-sync] Updated existing remote origin');
    } catch (e) {
      // Remote doesn't exist, add it
      await gitExec(['remote', 'add', 'origin', authenticatedUrl]);
      console.log('[cloud-sync] Added new remote origin');
    }

    return { success: true };
  } catch (error) {
    console.error('[cloud-sync] Error setting up remote:', error);
    return { success: false, error: error.message };
  }
}


/**
 * Configure secrets.yaml tracking based on settings
 * @param {boolean} include - Whether to include secrets.yaml
 */
async function configureSecretsTracking(include) {
  const secretsPath = 'secrets.yaml';
  const gitignorePath = path.join(CONFIG_PATH, '.gitignore');

  try {
    // 1. Manage .gitignore using the centralized generator
    // This ensures consistency with init/update logic
    const nestedRepos = await findNestedGitRepos();
    const desiredGitignoreContent = generateGitignoreContent(nestedRepos, runtimeSettings.extensions);

    let currentGitignoreContent = '';
    try {
      currentGitignoreContent = await fsPromises.readFile(gitignorePath, 'utf8');
    } catch (e) {
      // File doesn't exist
    }

    let gitignoreChanged = false;
    if (desiredGitignoreContent.trim() !== currentGitignoreContent.trim()) {
      await fsPromises.writeFile(gitignorePath, desiredGitignoreContent);
      gitignoreChanged = true;
      console.log(`[cloud-sync] Updated .gitignore (secrets included: ${include})`);
    } else {
      console.log('[cloud-sync] .gitignore is up to date');
    }

    // 2. Manage Git Index (Tracked/Untracked)
    const { stdout: trackedFiles } = await gitExec(['ls-files', secretsPath]);
    const isTracked = trackedFiles.trim() !== '';
    console.log(`[cloud-sync] secrets.yaml tracked: ${isTracked}, include: ${include}`);

    if (!include && isTracked) {
      // Stop tracking: Update .gitignore to exclude the file
      // IMPORTANT: We do NOT use 'git rm --cached' because it creates a deletion commit
      // that would remove the file from the remote repository when pushed.
      // Instead, we rely on .gitignore (already updated above) to prevent future tracking.
      // The file remains in repository history but won't be modified going forward.

      console.log('[cloud-sync] Excluding secrets.yaml via .gitignore (file remains in history, no deletion commit)');

      // Only commit .gitignore change if it was updated
      if (gitignoreChanged) {
        try {
          await gitExec(['add', '.gitignore']);
          await gitExec(['commit', '-m', 'Update .gitignore to exclude secrets.yaml']);
          console.log('[cloud-sync] Committed .gitignore update to exclude secrets.yaml');
        } catch (e) {
          console.log('[cloud-sync] Could not commit .gitignore update:', e.message);
        }
      }

      // Note: We do NOT stage/commit the removal of secrets.yaml itself
      // This prevents creating a deletion commit that would remove it from the remote
    } else if (include && !isTracked) {
      // Start tracking
      try {
        await gitExec(['add', secretsPath]);
        // Stage .gitignore if it changed
        if (gitignoreChanged) {
          await gitExec(['add', '.gitignore']);
        }
        console.log('[cloud-sync] Added secrets.yaml to tracking');
      } catch (e) {
        // File might not exist
        console.log('[cloud-sync] Could not add secrets.yaml:', e.message);
      }

      // Commit the addition (was previously missing)
      try {
        const msg = gitignoreChanged ? 'secrets.yaml, .gitignore' : 'secrets.yaml';
        await gitExec(['commit', '-m', msg]);
        console.log(`[cloud-sync] Committed secrets inclusion: ${msg}`);
      } catch (e) {
        console.log('[cloud-sync] Commit skipped (may already be tracked):', e.message);
      }
    } else if (gitignoreChanged) {
      // Just stage and commit .gitignore change
      try {
        await gitExec(['add', '.gitignore']);
        await gitExec(['commit', '-m', '.gitignore']);
        console.log('[cloud-sync] Committed .gitignore update');
      } catch (e) {
        console.log('[cloud-sync] Could not commit .gitignore update:', e.message);
      }
    }

  } catch (error) {
    console.error('[cloud-sync] Error configuring secrets:', error);
  }
}

/**
 * Push to remote repository
 * @param {boolean} includeSecrets - Whether to include secrets.yaml
 * @returns {Object} Result with success status
 */
async function pushToRemote(includeSecrets = false) {
  try {
    // Configure secrets tracking before pushing
    await configureSecretsTracking(includeSecrets);

    let localBranch = 'main';
    try {
      const branchResult = await gitRevparse(['--abbrev-ref', 'HEAD']);
      localBranch = branchResult.trim();
      if (localBranch === 'HEAD') localBranch = 'main'; // Should not happen in normal repos
    } catch (e) {
      console.log('[cloud-sync] Could not determine branch, defaulting to main');
    }

    // Push to the same branch on remote as local
    const remoteBranch = localBranch;
    console.log(`[cloud-sync] Pushing ${localBranch} to origin/${remoteBranch}...`);
    await gitExec(['push', '-f', '-u', 'origin', `${localBranch}:${remoteBranch}`], {
      ignoreSslErrors: runtimeSettings.cloudSync.ignoreSslErrors
    });
    console.log(`[cloud-sync] Successfully pushed to origin/${remoteBranch}`);

    // Update status
    const timestamp = new Date().toISOString();
    runtimeSettings.cloudSync.lastPushTime = timestamp;
    runtimeSettings.cloudSync.lastPushStatus = 'success';
    runtimeSettings.cloudSync.lastPushError = null;
    await saveRuntimeSettings();

    return { success: true, branch: remoteBranch };

  } catch (error) {
    console.error('[cloud-sync] Push failed:', error);

    // Update status
    runtimeSettings.cloudSync.lastPushTime = new Date().toISOString();
    runtimeSettings.cloudSync.lastPushStatus = 'error';
    runtimeSettings.cloudSync.lastPushError = error.message;
    await saveRuntimeSettings();

    return { success: false, error: error.message };
  }
}

/**
 * Test connection to remote repository
 * @returns {Object} Result with success status
 */
async function testRemoteConnection() {
  try {
    // Use ls-remote to test connection without actually pushing
    // Note: Don't use --exit-code as it fails on empty repos (exit code 2)
    await gitExec(['ls-remote', 'origin'], {
      ignoreSslErrors: runtimeSettings.cloudSync.ignoreSslErrors
    });
    console.log('[cloud-sync] Remote connection test successful');
    return { success: true };
  } catch (error) {
    console.error('[cloud-sync] Remote connection test failed:', error);
    return { success: false, error: error.message };
  }
}

// =====================================
// GitHub OAuth Device Flow
// =====================================

const GITHUB_CLIENT_ID = '178c6fc778ccc68e1d6a'; // Using GitHub CLI Client ID as fallback due to app restrictions

// Initiate GitHub Device Flow
app.post('/api/github/device-flow/initiate', async (req, res) => {
  try {
    const response = await fetch('https://github.com/login/device/code', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'HomeAssistantVersionControl/1.2.0'
      },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        scope: 'repo'
      })
    });

    const data = await response.json();

    if (data.error) {
      const errorMsg = data.error_description || data.error || 'Unknown GitHub error';
      console.error('[github device flow] Error:', errorMsg);
      return res.status(400).json({ success: false, error: errorMsg });
    }

    console.log('[github device flow] Initiated, user_code:', data.user_code);

    res.json({
      success: true,
      device_code: data.device_code,
      user_code: data.user_code,
      verification_uri: data.verification_uri,
      expires_in: data.expires_in,
      interval: data.interval
    });
  } catch (error) {
    console.error('[github device flow] Initiate error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Poll for GitHub Device Flow token
app.post('/api/github/device-flow/poll', async (req, res) => {
  try {
    const { device_code } = req.body;

    if (!device_code) {
      return res.status(400).json({ success: false, error: 'device_code is required' });
    }

    const response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'HomeAssistantVersionControl/1.2.0'
      },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        device_code: device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
      })
    });

    const data = await response.json();

    if (data.error) {
      // console.log('[github device flow] Poll status:', data.error); 

      if (data.error === 'authorization_pending') {
        return res.json({ success: false, pending: true, error: 'Authorization pending' });
      }
      if (data.error === 'slow_down') {
        return res.json({ success: false, slow_down: true, error: 'Slow down' });
      }
      if (data.error === 'expired_token') {
        return res.json({ success: false, expired: true, error: 'Code expired' });
      }
      if (data.error === 'access_denied') {
        return res.json({ success: false, denied: true, error: 'Access denied by user' });
      }

      console.error('[github device flow] Poll error response:', data);
      return res.status(400).json({ success: false, error: data.error_description || data.error });
    }

    if (data.access_token) {
      console.log('[github device flow] Token received successfully');

      // Save the token to cloud sync settings and enable sync
      runtimeSettings.cloudSync.authToken = data.access_token;
      runtimeSettings.cloudSync.authProvider = 'github';
      runtimeSettings.cloudSync.enabled = true; // Auto-enable when connected
      await saveRuntimeSettings();

      res.json({
        success: true,
        access_token: data.access_token,
        token_type: data.token_type,
        scope: data.scope
      });
    } else {
      res.json({ success: false, error: 'No access token in response' });
    }
  } catch (error) {
    console.error('[github device flow] Poll error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get GitHub user info (to show who's connected)
app.get('/api/github/user', async (req, res) => {
  try {
    const token = runtimeSettings.cloudSync.authToken;

    if (!token) {
      return res.json({ success: false, error: 'Not authenticated' });
    }

    const response = await fetch('https://api.github.com/user', {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'HomeAssistantVersionControl'
      }
    });

    if (!response.ok) {
      return res.json({ success: false, error: 'Invalid token' });
    }

    const user = await response.json();

    res.json({
      success: true,
      user: {
        login: user.login,
        avatar_url: user.avatar_url,
        name: user.name
      }
    });
  } catch (error) {
    console.error('[github user] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Disconnect GitHub (clear token)
app.post('/api/github/disconnect', async (req, res) => {
  try {
    runtimeSettings.cloudSync.authToken = '';
    runtimeSettings.cloudSync.authProvider = '';
    runtimeSettings.cloudSync.remoteUrl = '';
    runtimeSettings.cloudSync.lastPushTime = null;
    runtimeSettings.cloudSync.lastPushStatus = null;
    runtimeSettings.cloudSync.lastPushError = null;
    await saveRuntimeSettings();

    // Also remove the git remote to clear any embedded tokens
    try {
      await gitExec(['remote', 'remove', 'origin']);
      console.log('[github] Removed git remote origin');
    } catch (e) {
      // Remote might not exist, that's okay
      console.log('[github] No git remote to remove');
    }

    console.log('[github] Disconnected and cleared all cloud sync settings');
    res.json({ success: true });
  } catch (error) {
    console.error('[github disconnect] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Flush repository (git gc)
app.post('/api/git/flush', async (req, res) => {
  try {
    console.log('[git] Manual flush requested...');
    // Expire reflog first to make objects unreachable
    await gitRaw(['reflog', 'expire', '--expire=now', '--all']);
    // Run aggressive GC with a 5-minute timeout
    await gitRaw(['gc', '--prune=now', '--aggressive'], { timeout: 300000 });
    console.log('[git] Flush completed successfully');
    res.json({ success: true });
  } catch (error) {
    console.error('[git] Flush failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Create GitHub repository
app.post('/api/github/create-repo', async (req, res) => {
  try {
    const { repoName } = req.body;
    const token = runtimeSettings.cloudSync.authToken;

    if (!token) {
      return res.status(400).json({ success: false, error: 'Not authenticated with GitHub' });
    }

    if (!repoName) {
      return res.status(400).json({ success: false, error: 'Repository name is required' });
    }

    // Create private repository via GitHub API
    const response = await fetch('https://api.github.com/user/repos', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': 'HomeAssistantVersionControl'
      },
      body: JSON.stringify({
        name: repoName,
        description: 'Home Assistant configuration backup managed by Home Assistant Version Control',
        private: true,
        auto_init: false // Don't create README, we'll push our own content
      })
    });

    const data = await response.json();

    // Check if repo already exists - if so, fetch and use it
    if (!response.ok) {
      const alreadyExists = data.errors?.some(e => e.message?.includes('already exists')) ||
        data.message?.includes('already exists');

      if (alreadyExists) {
        console.log('[github create-repo] Repository already exists, fetching existing repo...');

        // Get the authenticated user to build the repo URL
        const userResponse = await fetch('https://api.github.com/user', {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'HomeAssistantVersionControl'
          }
        });

        if (!userResponse.ok) {
          return res.status(500).json({ success: false, error: 'Failed to get user info' });
        }

        const userData = await userResponse.json();

        // Fetch the existing repo
        const repoResponse = await fetch(`https://api.github.com/repos/${userData.login}/${repoName}`, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'HomeAssistantVersionControl'
          }
        });

        if (!repoResponse.ok) {
          return res.status(500).json({ success: false, error: 'Repository exists but could not be accessed' });
        }

        const repoData = await repoResponse.json();
        console.log('[github create-repo] Using existing repository:', repoData.clone_url);

        // Save the remote URL (both active and GitHub-specific)
        runtimeSettings.cloudSync.remoteUrl = repoData.clone_url;
        runtimeSettings.cloudSync.githubRemoteUrl = repoData.clone_url;
        await saveRuntimeSettings();

        // Set up the git remote
        await setupGitRemote(repoData.clone_url, token);

        return res.json({
          success: true,
          existing: true,
          repo: {
            name: repoData.name,
            full_name: repoData.full_name,
            url: repoData.html_url,
            clone_url: repoData.clone_url
          }
        });
      }

      console.error('[github create-repo] Error:', data.message);
      return res.status(response.status).json({
        success: false,
        error: data.message || 'Failed to create repository'
      });
    }

    console.log('[github create-repo] Created repository:', data.clone_url);

    // Save the remote URL (both active and GitHub-specific)
    runtimeSettings.cloudSync.remoteUrl = data.clone_url;
    runtimeSettings.cloudSync.githubRemoteUrl = data.clone_url;
    await saveRuntimeSettings();

    // Set up the git remote
    await setupGitRemote(data.clone_url, token);

    res.json({
      success: true,
      repo: {
        name: data.name,
        full_name: data.full_name,
        url: data.html_url,
        clone_url: data.clone_url
      }
    });
  } catch (error) {
    console.error('[github create-repo] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// =====================================
// Cloud Sync API Endpoints
// =====================================

// Get cloud sync status
app.get('/api/cloud-sync/status', async (req, res) => {
  try {
    res.json({
      success: true,
      enabled: runtimeSettings.cloudSync.enabled,
      lastPushTime: runtimeSettings.cloudSync.lastPushTime,
      lastPushStatus: runtimeSettings.cloudSync.lastPushStatus,
      lastPushError: runtimeSettings.cloudSync.lastPushError,
      pushFrequency: runtimeSettings.cloudSync.pushFrequency
    });
  } catch (error) {
    console.error('[cloud-sync status] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Test cloud sync connection
// Test cloud sync connection
app.post('/api/cloud-sync/test', async (req, res) => {
  try {
    const { remoteUrl, authToken, ignoreSslErrors } = req.body;

    // Use provided URL or fall back to stored URL
    const targetUrl = remoteUrl || runtimeSettings.cloudSync.remoteUrl;

    if (!targetUrl) {
      return res.status(400).json({ success: false, error: 'Remote URL is required' });
    }

    // Use provided token or fall back to stored token
    const token = authToken || runtimeSettings.cloudSync.authToken;

    // Temporarily update ignoreSslErrors if provided for the test
    const oldIgnoreSsl = runtimeSettings.cloudSync.ignoreSslErrors;
    if (ignoreSslErrors !== undefined) {
      runtimeSettings.cloudSync.ignoreSslErrors = ignoreSslErrors;
    }

    // Set up the remote with provided credentials
    const setupResult = await setupGitRemote(targetUrl, token);
    if (!setupResult.success) {
      return res.json({ success: false, error: setupResult.error });
    }

    // Test the connection
    const testResult = await testRemoteConnection();

    // Restore ignoreSslErrors
    runtimeSettings.cloudSync.ignoreSslErrors = oldIgnoreSsl;

    res.json(testResult);
  } catch (error) {
    console.error('[cloud-sync test] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Push to remote now
app.post('/api/cloud-sync/push', async (req, res) => {
  try {
    if (!runtimeSettings.cloudSync.enabled && !req.body.force) {
      return res.status(400).json({ success: false, error: 'Cloud sync is not enabled' });
    }

    if (!runtimeSettings.cloudSync.remoteUrl) {
      return res.status(400).json({ success: false, error: 'Remote URL not configured' });
    }

    // Set up remote (in case settings changed)
    const setupResult = await setupGitRemote(
      runtimeSettings.cloudSync.remoteUrl,
      runtimeSettings.cloudSync.authToken
    );
    if (!setupResult.success) {
      return res.json({ success: false, error: setupResult.error });
    }

    // Push
    const pushResult = await pushToRemote(runtimeSettings.cloudSync.includeSecrets);
    res.json(pushResult);
  } catch (error) {
    console.error('[cloud-sync push] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});


// Save cloud sync settings
app.post('/api/cloud-sync/settings', async (req, res) => {
  try {
    console.log('[cloud-sync settings] Received request:', JSON.stringify(req.body, null, 2));
    const { enabled, remoteUrl, authToken, pushFrequency, includeSecrets, ignoreSslErrors, authProvider } = req.body;

    // Update basic settings
    console.log('[cloud-sync settings] Updating local settings...');
    if (enabled !== undefined) runtimeSettings.cloudSync.enabled = enabled;
    if (authToken !== undefined) runtimeSettings.cloudSync.authToken = authToken;
    if (pushFrequency !== undefined) runtimeSettings.cloudSync.pushFrequency = pushFrequency;
    if (includeSecrets !== undefined) runtimeSettings.cloudSync.includeSecrets = includeSecrets;
    if (ignoreSslErrors !== undefined) runtimeSettings.cloudSync.ignoreSslErrors = ignoreSslErrors;

    // Handle provider and URL switching
    const oldProvider = runtimeSettings.cloudSync.authProvider;
    const newProvider = authProvider !== undefined ? authProvider : oldProvider;

    if (authProvider !== undefined) {
      runtimeSettings.cloudSync.authProvider = authProvider;
    }

    // Determine which URL to use based on provider
    let effectiveUrl = remoteUrl;

    if (newProvider === 'github') {
      // Switching to GitHub - use stored GitHub URL if available, or provided URL
      if (remoteUrl) {
        // Save to GitHub-specific storage
        runtimeSettings.cloudSync.githubRemoteUrl = remoteUrl;
        effectiveUrl = remoteUrl;
      } else if (runtimeSettings.cloudSync.githubRemoteUrl) {
        // Restore stored GitHub URL
        effectiveUrl = runtimeSettings.cloudSync.githubRemoteUrl;
        console.log('[cloud-sync settings] Restored GitHub URL:', effectiveUrl);
      } else {
        // Fallback: check if current remoteUrl is a GitHub URL (migration case)
        const currentUrl = runtimeSettings.cloudSync.remoteUrl || '';
        if (currentUrl.includes('github.com')) {
          effectiveUrl = currentUrl;
          runtimeSettings.cloudSync.githubRemoteUrl = currentUrl;
          console.log('[cloud-sync settings] Migrated GitHub URL from remoteUrl:', effectiveUrl);
        } else {
          console.log('[cloud-sync settings] No GitHub URL found - user needs to connect GitHub');
        }
      }
    } else if (newProvider === 'generic') {
      // Switching to Custom - use provided URL or stored custom URL
      if (remoteUrl) {
        // Save to custom-specific storage
        runtimeSettings.cloudSync.customRemoteUrl = remoteUrl;
        effectiveUrl = remoteUrl;
      } else if (runtimeSettings.cloudSync.customRemoteUrl) {
        // Restore stored custom URL
        effectiveUrl = runtimeSettings.cloudSync.customRemoteUrl;
        console.log('[cloud-sync settings] Restored Custom URL:', effectiveUrl);
      } else {
        // Fallback: check if current remoteUrl is NOT a GitHub URL
        const currentUrl = runtimeSettings.cloudSync.remoteUrl || '';
        if (currentUrl && !currentUrl.includes('github.com')) {
          effectiveUrl = currentUrl;
          runtimeSettings.cloudSync.customRemoteUrl = currentUrl;
          console.log('[cloud-sync settings] Migrated Custom URL from remoteUrl:', effectiveUrl);
        }
      }
    }

    // Update the active URL
    if (effectiveUrl !== undefined) {
      runtimeSettings.cloudSync.remoteUrl = effectiveUrl;
    }

    // Set up remote if URL and token provided
    if (effectiveUrl && enabled) {
      console.log('[cloud-sync settings] Setting up git remote...');
      await setupGitRemote(effectiveUrl, authToken || runtimeSettings.cloudSync.authToken);
    }

    // Apply secrets tracking configuration immediately
    console.log('[cloud-sync settings] Configuring secrets tracking...');
    await configureSecretsTracking(runtimeSettings.cloudSync.includeSecrets);

    console.log('[cloud-sync settings] Saving runtime settings...');
    await saveRuntimeSettings();
    console.log('[cloud-sync settings] Success!');
    res.json({ success: true, settings: runtimeSettings.cloudSync });
  } catch (error) {
    console.error('[cloud-sync settings] Error:', error);
    console.error('[cloud-sync settings] Stack:', error.stack);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get cloud sync settings (excluding sensitive token)
app.get('/api/cloud-sync/settings', async (req, res) => {
  try {
    res.json({
      success: true,
      settings: {
        enabled: runtimeSettings.cloudSync.enabled,
        remoteUrl: runtimeSettings.cloudSync.remoteUrl,
        githubRemoteUrl: runtimeSettings.cloudSync.githubRemoteUrl,
        customRemoteUrl: runtimeSettings.cloudSync.customRemoteUrl,
        authProvider: runtimeSettings.cloudSync.authProvider,
        hasAuthToken: !!runtimeSettings.cloudSync.authToken,
        pushFrequency: runtimeSettings.cloudSync.pushFrequency,
        includeSecrets: runtimeSettings.cloudSync.includeSecrets,
        lastPushTime: runtimeSettings.cloudSync.lastPushTime,
        lastPushStatus: runtimeSettings.cloudSync.lastPushStatus,
        lastPushError: runtimeSettings.cloudSync.lastPushError
      }
    });
  } catch (error) {
    console.error('[cloud-sync settings] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get avatar URL for custom repo (Gitea/Forgejo)
app.get('/api/cloud-sync/avatar', async (req, res) => {
  try {
    const { remoteUrl } = req.query;
    if (!remoteUrl) {
      return res.status(400).json({ success: false, error: 'remoteUrl is required' });
    }

    // Use stored token if available for authentication
    const settings = runtimeSettings.cloudSync || {};
    let token = '';

    // Extract token from stored URL if present
    if (settings.remoteUrl && settings.remoteUrl.includes('@')) {
      const match = settings.remoteUrl.match(/:\/\/(.*?)@/);
      if (match) token = match[1];
    }

    // Parse URL to get base URL and username
    const cleanUrl = remoteUrl.replace(/:\/\/(.*?)@/, '://'); // Strip token for parsing
    const urlObj = new URL(cleanUrl);
    const pathParts = urlObj.pathname.split('/').filter(p => p);

    if (pathParts.length < 2) {
      return res.status(400).json({ success: false, error: 'Invalid repo URL format' });
    }

    const username = pathParts[0];
    const headers = {};
    if (token) {
      headers['Authorization'] = `token ${token}`;
    }

    // Try to detect provider type by testing different APIs
    let provider = 'custom';
    let userData = null;

    // Try Gitea/Forgejo API first (most common for self-hosted)
    try {
      const giteaUrl = `${urlObj.origin}/api/v1/users/${username}`;
      console.log(`[avatar] Trying Gitea API: ${giteaUrl}`);
      const giteaRes = await fetch(giteaUrl, { headers });
      if (giteaRes.ok) {
        userData = await giteaRes.json();
        provider = 'gitea';
        console.log(`[avatar] Detected Gitea/Forgejo provider`);
      }
    } catch (e) {
      console.log(`[avatar] Gitea API failed: ${e.message}`);
    }

    // Try GitLab API if Gitea didn't work
    if (!userData) {
      try {
        const gitlabHeaders = { ...headers };
        if (token) {
          gitlabHeaders['PRIVATE-TOKEN'] = token;
          delete gitlabHeaders['Authorization'];
        }
        const gitlabUrl = `${urlObj.origin}/api/v4/users?username=${username}`;
        console.log(`[avatar] Trying GitLab API: ${gitlabUrl}`);
        const gitlabRes = await fetch(gitlabUrl, { headers: gitlabHeaders });
        if (gitlabRes.ok) {
          const users = await gitlabRes.json();
          if (Array.isArray(users) && users.length > 0) {
            userData = users[0];
            provider = 'gitlab';
            console.log(`[avatar] Detected GitLab provider`);
          }
        }
      } catch (e) {
        console.log(`[avatar] GitLab API failed: ${e.message}`);
      }
    }

    if (userData) {
      res.json({
        success: true,
        provider: provider,
        avatarUrl: userData.avatar_url || null,
        username: userData.login || userData.username || username,
        fullName: userData.full_name || userData.name || userData.login || userData.username || username
      });
    } else {
      // Couldn't detect provider, return basic info
      res.json({
        success: true,
        provider: 'custom',
        avatarUrl: null,
        username: username,
        fullName: username
      });
    }

  } catch (error) {
    console.warn(`[avatar] Failed to fetch user info: ${error.message}`);
    res.json({ success: false, error: error.message });
  }
});

// Keep the process alive
process.on('SIGTERM', () => {
  console.log('[init] SIGTERM received, shutting down...');
  server.close(() => {
    console.log('[init] Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('[init] SIGINT received, shutting down...');
  server.close(() => {
    console.log('[init] Server closed');
    process.exit(0);
  });
});
