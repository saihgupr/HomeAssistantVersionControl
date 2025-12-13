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
  restoreScript
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
const HOST = process.env.HOST || '0.0.0.0';

// Ensure HOME is set for git
if (!process.env.HOME) {
  process.env.HOME = '/tmp';
  console.log('[init] Set HOME=/tmp for git compatibility');
}

// Configure git at runtime (safe.directory and identity)
// This must happen AFTER HOME is set, since git config --global writes to $HOME/.gitconfig
try {
  execSync('git config --global --add safe.directory /config', { stdio: 'pipe' });
  execSync('git config --global --add safe.directory /usr/src/app', { stdio: 'pipe' });
  execSync('git config --global user.email "havc@local"', { stdio: 'pipe' });
  execSync('git config --global user.name "Home Assistant Version Control"', { stdio: 'pipe' });
  console.log('[init] Git configured: safe.directory and identity set');
} catch (e) {
  console.error('[init] Failed to configure git:', e.message);
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
let configOptions = {
  yaml_format: true,
  json_format: false,
  py_format: false,
  txt_format: false,
  invisible_files: true
};

// Runtime settings loaded from file
let runtimeSettings = {
  debounceTime: 5, // time value
  debounceTimeUnit: 'seconds', // 'seconds', 'minutes', 'hours', 'days'
  historyRetention: false,
  retentionType: 'time', // 'time' or 'versions'
  retentionValue: 90,
  retentionUnit: 'days', // 'hours', 'days', 'weeks', 'months'

};

// Global lock for cleanup operations
let cleanupLock = false;

// Helper function to ensure git is initialized
function ensureGitInitialized() {
  if (!git || !gitInitialized) {
    throw new Error('Git repository not initialized yet. Please try again in a moment.');
  }
}

/**
 * Get configured file extensions based on addon config
 * @returns {Array<string>} Array of extensions like ['.yaml', '.yml']
 */
function getConfiguredExtensions() {
  const extensions = [];

  if (configOptions.yaml_format) {
    extensions.push('.yaml', '.yml');
  }
  if (configOptions.json_format) {
    extensions.push('.json');
  }
  if (configOptions.py_format) {
    extensions.push('.py');
  }
  if (configOptions.txt_format) {
    extensions.push('.txt');
  }

  return extensions;
}

/**
 * Generate .gitignore content based on configured extensions
 * @returns {string} .gitignore file content
 */
const IGNORED_NESTED_REPOS = [];

/**
 * Generate .gitignore content based on configured extensions
 * @param {Array<string>} extraIgnores - Additional paths to ignore
 * @returns {string} .gitignore file content
 */
function generateGitignoreContent(extraIgnores = []) {

  const extensions = getConfiguredExtensions();
  const invisiblePattern = configOptions.invisible_files ? '!**/.??*.' : '';
  const dirTraversal = '!*/';

  if (extensions.length === 0) {
    // If no extensions configured, ignore everything
    return `# No file formats configured - ignoring all files\n*\n${dirTraversal}\n`;
  }

  let content = `# Only track specific file types\n# Ignore everything by default\n*\n\n`;

  // Add extensions
  for (const ext of extensions) {
    const extension = ext.replace('.', ''); // Remove the dot for the pattern
    content += `!*.${extension}\n`;
    if (configOptions.invisible_files) {
      content += `!**/.??*.${extension}\n`;
    }
  }

  // Add lovelace storage files
  content += `\n# Track lovelace dashboard configuration files\n`;
  content += `!.storage/lovelace\n`;
  content += `!.storage/lovelace_dashboards\n`;
  content += `!.storage/lovelace_resources\n`;
  content += `!.storage/lovelace.*\n`;

  content += `\n# Allow directory traversal\n${dirTraversal}\n`;

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
  try {
    const settingsData = await fsPromises.readFile('/data/runtime-settings.json', 'utf-8');
    const settings = JSON.parse(settingsData);
    runtimeSettings = { ...runtimeSettings, ...settings };
    console.log('[init] Loaded runtime settings:', runtimeSettings);
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log('[init] Runtime settings file not found, using defaults.');
    } else {
      console.error('[init] Error loading runtime settings:', error.message);
      console.log('[init] Using default runtime settings due to error.');
    }
  }
}

/**
 * Save runtime settings to file
 */
async function saveRuntimeSettings() {
  try {
    await fsPromises.writeFile('/data/runtime-settings.json', JSON.stringify(runtimeSettings, null, 2), 'utf-8');
    console.log('[settings] Saved runtime settings');
  } catch (error) {
    console.error('[settings] Failed to save runtime settings:', error.message);
    throw error;
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

  if (extensions.length === 0) {
    console.log('[getConfigFiles] No file formats enabled, returning empty array');
    return [];
  }

  // Build pattern like: /config/**/*.{yaml,yml}
  const extensionsStr = extensions.join(',');
  const pattern = `${CONFIG_PATH}/**/*{${extensionsStr.substring(1)}}`; // Remove first dot and join

  return new Promise((resolve, reject) => {
    glob(pattern, { nodir: true }, (err, files) => {
      if (err) reject(err);
      else resolve(files);
    });
  });
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


async function initRepo() {
  try {
    // Determine CONFIG_PATH
    CONFIG_PATH = process.env.CONFIG_PATH;

    // Also check for config.json in the data directory
    try {
      const configData = await fs.readFile('/data/options.json', 'utf-8');
      const config = JSON.parse(configData);
      if (config.liveConfigPath) {
        CONFIG_PATH = config.liveConfigPath;
      }
      // File format options are now hardcoded (YAML only, invisible files enabled)
      console.log(`[init] Using hardcoded file format options:`, configOptions);
    } catch (error) {
      // Ignore if file doesn't exist
    }

    // Load runtime settings
    await loadRuntimeSettings();

    // Default to /config
    if (!CONFIG_PATH) {
      CONFIG_PATH = '/config';
    }

    console.log(`[init] CONFIG_PATH: ${CONFIG_PATH}`);
    console.log(`[init] Current working directory: ${process.cwd()}`);

    // Initialize git with the correct path
    global.CONFIG_PATH = CONFIG_PATH;

    // Check if directory exists
    try {
      await fsPromises.access(CONFIG_PATH);
    } catch (error) {
      console.log(`[init] CONFIG_PATH does not exist, creating it...`);
      await fsPromises.mkdir(CONFIG_PATH, { recursive: true });
    }

    const isRepo = await gitCheckIsRepo();

    // Check for nested git repositories to ignore
    const nestedRepos = await findNestedGitRepos();
    if (nestedRepos.length > 0) {
      IGNORED_NESTED_REPOS.push(...nestedRepos);
    }

    if (!isRepo) {
      console.log(`[init] Initializing Git repo at ${CONFIG_PATH}...`);
      await gitInit();

      // Create .gitignore to limit git to only config files
      const gitignorePath = path.join(CONFIG_PATH, '.gitignore');
      const gitignoreContent = generateGitignoreContent(nestedRepos);
      try {
        await fsPromises.access(gitignorePath, fs.constants.F_OK);
        console.log('[init] .gitignore already exists in CONFIG_PATH');
      } catch (error) {
        console.log('[init] Creating .gitignore in CONFIG_PATH to limit git to config files only...');
        await fsPromises.writeFile(gitignorePath, gitignoreContent, 'utf8');
        console.log('[init] Created .gitignore in CONFIG_PATH');
      }

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

    // Create .gitignore to limit git to only config files (only for existing repos)
    const gitignorePath = path.join(CONFIG_PATH, '.gitignore');
    const gitignoreContent = generateGitignoreContent(nestedRepos);

    if (isRepo) {
      try {
        // Check if .gitignore exists and if content matches
        const existingContent = await fsPromises.readFile(gitignorePath, 'utf8');
        if (existingContent.trim() === gitignoreContent.trim()) {
          console.log('[init] .gitignore already exists and is up to date');
        } else {
          console.log('[init] Updating .gitignore (content changed)...');
          await fsPromises.writeFile(gitignorePath, gitignoreContent, 'utf8');
          console.log('[init] Updated .gitignore in CONFIG_PATH');
        }
      } catch (error) {
        // .gitignore doesn't exist, create it
        console.log('[init] Creating .gitignore in CONFIG_PATH to limit git to config files only...');
        await fsPromises.writeFile(gitignorePath, gitignoreContent, 'utf8');
        console.log('[init] Created .gitignore in CONFIG_PATH');
      }
    }

    // Clean up nested repos from index BEFORE doing git add
    // This prevents them from being re-committed in the startup backup
    if (nestedRepos.length > 0) {
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
    if (isRepo) {
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
    } else {
      console.log('[init] No changes to backup for existing repository');
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
          // Check if file matches any of the configured extensions or is a lovelace file
          const matchesExtension = allowedExtensions.some(ext =>
            entry.name.toLowerCase().endsWith(ext)
          );
          const isLovelaceFile = relPath.startsWith('.storage/lovelace');

          if (matchesExtension || isLovelaceFile) {
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

// Git History
app.get('/api/git/history', async (req, res) => {
  try {
    const log = await gitLog({ maxCount: 50 });
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
    const fullPath = path.join(CONFIG_PATH, filePath);
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
    const maxCount = 50; // Increased from 20 to show more history
    const log = await gitLog({ file: filePath, maxCount });

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
    await gitCheckoutSafe(commitHash, filePath);
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
      const isLovelaceFile = file.includes('.storage/lovelace');
      return hasAllowedExt || isLovelaceFile;
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
        const isLovelaceFile = file.includes('.storage/lovelace');
        return hasAllowedExt || isLovelaceFile;
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
      await gitCheckoutSafe(target, file);
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
        await gitCheckoutSafe(commitHash, file);
      }
      console.log(`[hard-reset] All files checked out from ${commitHash.substring(0, 8)}`);

      // Get the commit date for a better commit message
      let commitDate = '';
      try {
        const dateStr = (await gitRaw(['show', '-s', '--format=%aI', commitHash])).trim();
        const date = new Date(dateStr);

        // Format as "Nov 26, 2025 12:30 PM" (no comma after year)
        const datePart = date.toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric'
        });
        const timePart = date.toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          hour12: true
        });
        commitDate = `${datePart} ${timePart}`;
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


// Git status
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




// File watcher for auto-commit (will be initialized in initRepo)
// Use a Map to track debounce timers per file
const debounceTimers = new Map();
let watcher = null;

function initializeWatcher() {
  const allowedExtensions = getConfiguredExtensions();
  const extensionsStr = allowedExtensions.map(ext => ext.substring(1)).join(','); // Remove dot for pattern
  console.log(`[init] Setting up file watcher for: ${CONFIG_PATH}/**/*{${extensionsStr}}`);

  // Use a more specific pattern to avoid ELOOP errors
  // Also watch lovelace storage files
  const watchPattern = [
    `${CONFIG_PATH}/**/*{${extensionsStr}}`,
    `${CONFIG_PATH}/.storage/lovelace`,
    `${CONFIG_PATH}/.storage/lovelace_dashboards`,
    `${CONFIG_PATH}/.storage/lovelace_resources`,
    `${CONFIG_PATH}/.storage/lovelace.*`
  ];

  watcher = chokidar.watch(watchPattern, {
    persistent: true,
    ignoreInitial: true,
    depth: 15,
    followSymlinks: false,
    usePolling: true,
    interval: 2000,
    binaryInterval: 2000,
    awaitWriteFinish: {
      stabilityThreshold: 2000,
      pollInterval: 100
    },
    ignored: (path, stats) => {
      // Ignore if path contains these directories (but not .storage for lovelace files)
      if (/(\/|^)\.(git|hg|svn|ssh|docker|ssl|keys|certs|node_modules)(\/|$)/.test(path)) {
        return true;
      }

      // Explicitly ignore .storage files except lovelace files
      if (path.includes('/.storage/') && !path.includes('/.storage/lovelace')) {
        return true;
      }

      // Avoid infinite loops - if path has too many repetitions of /config/
      const configCount = (path.match(/\/config\//g) || []).length;
      if (configCount > 3) {
        return true;
      }

      return false;
    }
  });

  // Handler function for both 'change' and 'add' events
  const handleFileEvent = async (filePath, eventType) => {
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

        // Check if file is a config file (has allowed extension) or is a lovelace storage file
        const hasAllowedExt = getConfiguredExtensions().some(ext =>
          relativePath.toLowerCase().endsWith(ext)
        );

        const isLovelaceFile = relativePath.startsWith('.storage/lovelace');

        if (!hasAllowedExt && !isLovelaceFile) {
          console.log(`[watcher] Skipping non-config file: ${relativePath}`);
          debounceTimers.delete(filePath);
          return;
        }

        // Check if this is only a formatting change (for YAML files)
        // Removed: We want to track ALL changes, including comments and formatting

        // Clear staging area to prevent accumulation of files from previous changes
        await gitRaw(['reset']);
        console.log(`[watcher] Adding file: ${relativePath}`);
        await gitAdd(relativePath);

        // Check if there are actually changes to commit
        const status = await gitStatus();
        if (status.isClean()) {
          console.log(`[watcher] No changes to commit for ${relativePath} (already up to date)`);
          debounceTimers.delete(filePath);
          return;
        }

        // Get all staged files and filter to only include allowed patterns
        const allStagedFiles = status.files
          .filter(f => f.index !== ' ' && f.index !== '?');

        // Filter out any files that shouldn't be tracked
        const stagedFiles = allStagedFiles
          .filter(f => {
            const filePath = f.path.trim(); // Trim to remove leading/trailing spaces from git status
            const hasAllowedExt = getConfiguredExtensions().some(ext => filePath.endsWith(ext));
            const isLovelaceFile = filePath.startsWith('.storage/lovelace');
            const shouldInclude = hasAllowedExt || isLovelaceFile;

            // Debug logging
            if (!shouldInclude) {
              console.log(`[watcher] Filtering out file: ${filePath} (hasAllowedExt: ${hasAllowedExt}, isLovelaceFile: ${isLovelaceFile})`);
            }

            return shouldInclude;
          })
          .map(f => f.path.trim()); // Also trim when extracting the path

        // Debug: show what files passed the filter
        console.log(`[watcher] Files after filtering: ${stagedFiles.join(', ')} (${stagedFiles.length} file(s))`);

        // Safety check: if no valid files to commit, clean up and return
        if (stagedFiles.length === 0) {
          console.log(`[watcher] No valid files to commit after filtering`);
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

  watcher.on('ready', () => {
    console.log('[init] File watcher ready and watching for changes');
  });

  watcher.on('error', error => {
    console.error('[watcher] Error:', error);
  });
}


// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    serverRunning: true,
    gitInitialized: gitInitialized || false,
    fileWatcherActive: watcher !== null,
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
      patterns.push('.storage/lovelace*'); // Include lovelace files

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
          const isLovelaceFile = filePath.startsWith('.storage/lovelace');
          return hasAllowedExt || isLovelaceFile;
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
  console.log('Home Assistant Version Control v1.0.0');
  console.log('='.repeat(60));
  console.log(`Server running at http://${HOST}:${PORT}`);

  // Run initialization in background to avoid blocking server startup
  initRepo()
    .then(() => {
      initializeWatcher();
    })
    .catch((error) => {
      console.error('[init] Background initialization error:', error);
    });
});

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
    const { success, history, debugMessages } = await getAutomationHistory(id, CONFIG_PATH);
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
    const { success, history, debugMessages } = await getScriptHistory(id, CONFIG_PATH);
    res.json({ success, history, debugMessages });
  } catch (error) {
    console.error('[script history] Error:', error);
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
