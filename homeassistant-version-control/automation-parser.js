import fs from 'fs';
import yaml from 'js-yaml';
import {
  gitCheckIsRepo,
  gitLog,
  gitShowFileAtCommit,
  gitDiff,
  gitRaw
} from './utils/git.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);



// Get the base directory (where server.js is located)
const BASE_DIR = __dirname;

/**
 * Parse configuration.yaml to find automation and script file locations
 * @param {string} configPath - Path to the config directory
 * @returns {Object} Object with automationPaths and scriptPaths arrays
 */
export async function getConfigFilePaths(configPath) {
  console.log('[getConfigFilePaths] Looking for configuration.yaml in:', configPath);
  const configFile = path.join(configPath, 'configuration.yaml');
  const automationPaths = [];
  const scriptPaths = [];

  try {
    const configContent = await fs.promises.readFile(configFile, 'utf-8');
    console.log('[getConfigFilePaths] Found configuration.yaml, parsing...');

    // Manually parse for automation and script directives
    // Handle Home Assistant's !include syntax
    const lines = configContent.split('\n');
    for (const line of lines) {
      const trimmedLine = line.trim();

      // Match automation: !include filename.yaml
      const autoMatch = trimmedLine.match(/^automation:\s*!include\s+(.+)$/);
      if (autoMatch) {
        const file = autoMatch[1].trim();
        automationPaths.push(path.join(configPath, file));
      }

      // Match script: !include filename.yaml
      const scriptMatch = trimmedLine.match(/^script:\s*!include\s+(.+)$/);
      if (scriptMatch) {
        const file = scriptMatch[1].trim();
        scriptPaths.push(path.join(configPath, file));
      }

      // Match automation: !include_dir_list dir_name
      const autoDirMatch = trimmedLine.match(/^automation:\s*!include_dir_list\s+(.+)$/);
      if (autoDirMatch) {
        const dir = autoDirMatch[1].trim();
        const fullDir = path.join(configPath, dir);
        try {
          const files = await fs.promises.readdir(fullDir);
          for (const file of files) {
            if (file.endsWith('.yaml') || file.endsWith('.yml')) {
              automationPaths.push(path.join(fullDir, file));
            }
          }
        } catch (err) {
          // Directory might not exist, ignore
        }
      }

      // Match script: !include_dir_list dir_name
      const scriptDirMatch = trimmedLine.match(/^script:\s*!include_dir_list\s+(.+)$/);
      if (scriptDirMatch) {
        const dir = scriptDirMatch[1].trim();
        const fullDir = path.join(configPath, dir);
        try {
          const files = await fs.promises.readdir(fullDir);
          for (const file of files) {
            if (file.endsWith('.yaml') || file.endsWith('.yml')) {
              scriptPaths.push(path.join(fullDir, file));
            }
          }
        } catch (err) {
          // Directory might not exist, ignore
        }
      }
    }

    // Default fallback if nothing found in config
    if (automationPaths.length === 0) {
      automationPaths.push(path.join(configPath, 'automations.yaml'));
    }
    if (scriptPaths.length === 0) {
      scriptPaths.push(path.join(configPath, 'scripts.yaml'));
    }

  } catch (error) {
    // If configuration.yaml doesn't exist or can't be read, use defaults
    automationPaths.push(path.join(configPath, 'automations.yaml'));
    scriptPaths.push(path.join(configPath, 'scripts.yaml'));
  }

  console.log('[getConfigFilePaths] Automation paths:', automationPaths);
  console.log('[getConfigFilePaths] Script paths:', scriptPaths);
  return { automationPaths, scriptPaths };
}

/**
 * Helper to parse the identifier from an ID string, reconstructing it if it contained colons
 * @param {string} fullId - The full ID string (e.g. 'automations:path/to/file.yaml:identifier')
 * @returns {Object} Object with filePath and identifier
 */
function parseId(fullId) {
  const parts = fullId.split(':');
  const { type, filePath, encodedPath, identifier } = { 
    type: parts[0], 
    filePath: decodeURIComponent(parts[1] || '').replace(/^\//, ''), 
    encodedPath: parts[1] || '', 
    identifier: decodeURIComponent(parts.slice(2).join(':')) 
  };
  console.log(`[parseId] type=${type}, identifier=${identifier}, filePath=${filePath}`);
  return { type, filePath, encodedPath, identifier };
}

/**
 * Helper to find an item in a collection by string-matching ID or alias, falling back to index
 */
function findItemByIdentifier(collection, identifier, isArray) {
  if (isArray) {
    // 1. Try to find by UUID (stringified to handle numeric IDs parsed as numbers by js-yaml)
    let found = collection.find(item => item && String(item.id) === String(identifier));
    if (found) {
      console.log(`[findItemByIdentifier] Found by ID: "${identifier}"`);
      return found;
    }
    // 2. Try to find by alias (fallback identifier) - Case-insensitive
    found = collection.find(item => item && item.alias && String(item.alias).toLowerCase() === String(identifier).toLowerCase());
    if (found) {
      console.log(`[findItemByIdentifier] Found by Alias: "${identifier}"`);
      return found;
    }
    // 3. Fallback to index ONLY if identifier is purely numeric
    if (/^\d+$/.test(String(identifier))) {
      const idx = parseInt(identifier);
      if (idx >= 0 && idx < collection.length) {
        console.log(`[findItemByIdentifier] Falling back to Index: ${idx} for identifier: "${identifier}"`);
        return collection[idx];
      }
    }
    
    // Debug output to help understand failures
    console.log(`[findItemByIdentifier] NOT FOUND for identifier: "${identifier}". Available aliases: ${collection.slice(0, 5).map(i => i?.alias).join(', ')}...`);
  } else { // Object
    const values = Object.values(collection);
    // 1. Try to find by UUID (values)
    let found = values.find(item => item && String(item.id) === String(identifier));
    if (found) return found;
    // 2. Try to find by alias (values)
    found = values.find(item => item && String(item.alias) === String(identifier));
    if (found) return found;
    // 3. Fallback to key
    return collection[identifier];
  }
  return null;
}

/**
 * Helper to find the start line of an automation or script
 */
function findStartLine(lines, item) {
  if (!item) return 1;

  // Try ID first
  if (item.id) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      // Check for id: "value" or - id: "value"
      if ((line.startsWith('id:') || line.startsWith('- id:')) && line.includes(item.id)) {
        return i + 1;
      }
    }
  }

  // Try Alias
  if (item.alias) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if ((line.startsWith('alias:') || line.startsWith('- alias:')) && line.includes(item.alias)) {
        return i + 1;
      }
    }
  }

  return 1;
}

/**
 * Extract all automations from YAML files
 * @param {string} configPath - Path to the config directory
 * @returns {Array} List of automation objects
 */
export async function extractAutomations(configPath = null) {
  const automations = [];
  const targetPath = configPath || BASE_DIR;

  try {
    // Get automation paths from configuration.yaml
    const { automationPaths } = await getConfigFilePaths(targetPath);

    // Process only automation files
    for (const filePath of automationPaths) {
      try {
        // Check if file exists before trying to read it
        let fileStats;
        try {
          fileStats = await fs.promises.stat(filePath);
        } catch (e) {
          continue; // Skip non-existent files
        }

        const content = await fs.promises.readFile(filePath, 'utf-8');
        const fileLines = content.split(/\r\n?|\n/);
        const data = yaml.load(content);

        if (data) {
          // Ensure the file path is relative to configPath for Git operations
          const relativeToConfigPath = path.relative(configPath, filePath);
          const mtime = fileStats.mtimeMs;

          // Check if automations is wrapped in an 'automations' key (array or object)
          if (data.automations) {
            if (Array.isArray(data.automations)) {
              data.automations.forEach((auto, index) => {
                if (auto.alias) {
                  // Use UUID if available, then fallback to alias, then index
                  // Format: automations:FILE:UUID_OR_ALIAS_OR_INDEX
                  const uniqueId = auto.id || auto.alias || index;

                  automations.push({
                    id: `automations:${encodeURIComponent(relativeToConfigPath)}:${uniqueId}`,
                    // Also store the raw ID for matching
                    rawId: auto.id,
                    name: auto.alias,
                    type: 'automation',
                    file: relativeToConfigPath, // Store relative path
                    index: index,
                    content: auto,
                    line: findStartLine(fileLines, auto),
                    fullPath: filePath,
                    mtime: mtime
                  });
                }
              });
            } else {
              // Object format
              Object.keys(data.automations).forEach(autoName => {
                const auto = data.automations[autoName];
                // Use UUID if available, then fallback to alias, then key name
                const uniqueId = auto.id || auto.alias || autoName;

                automations.push({
                  id: `automations:${encodeURIComponent(relativeToConfigPath)}:${uniqueId}`,
                  rawId: auto.id,
                  name: autoName,
                  type: 'automation',
                  file: relativeToConfigPath, // Store relative path
                  key: autoName,
                  content: auto,
                  line: findStartLine(fileLines, auto),
                  fullPath: filePath,
                  mtime: mtime
                });
              });
            }
          } else {
            // Standard Home Assistant format: automations at root level
            // Check if this looks like an automation by checking for automation-specific properties
            if (Array.isArray(data)) {
              data.forEach((auto, index) => {
                if (auto && typeof auto === 'object' && auto.alias) {
                  const uniqueId = auto.id || auto.alias || index;
                  automations.push({
                    id: `automations:${encodeURIComponent(relativeToConfigPath)}:${uniqueId}`,
                    rawId: auto.id,
                    name: auto.alias,
                    type: 'automation',
                    file: relativeToConfigPath,
                    index: index,
                    content: auto,
                    line: findStartLine(fileLines, auto),
                    fullPath: filePath,
                    mtime: mtime
                  });
                }
              });
            } else {
              Object.keys(data).forEach(key => {
                const auto = data[key];
                // Skip comments and other non-object entries
                if (auto && typeof auto === 'object' && auto.alias) {
                  // Automations have triggers (or trigger) and/or conditions
                  const hasTriggers = auto.triggers || auto.trigger;

                  // If it has triggers, it's an automation
                  if (hasTriggers) {
                    const uniqueId = auto.id || auto.alias || key;
                    automations.push({
                      id: `automations:${encodeURIComponent(relativeToConfigPath)}:${uniqueId}`,
                      rawId: auto.id,
                      name: auto.alias || key,
                      type: 'automation',
                      file: relativeToConfigPath, // Store relative path
                      key: key,
                      content: auto,
                      line: findStartLine(fileLines, auto),
                      fullPath: filePath,
                      mtime: mtime
                    });
                  }
                }
              });
            }
          }
        }
      } catch (error) {
        // Skip invalid YAML files
        console.log(`Skipping ${filePath}: invalid YAML`);
      }
    }

  } catch (error) {
    console.error('Error extracting automations:', error);
  }

  return automations;
}

/**
 * Extract all scripts from YAML files
 * @param {string} configPath - Path to the config directory
 * @returns {Array} List of script objects
 */
export async function extractScripts(configPath = null) {
  const scripts = [];
  const targetPath = configPath || BASE_DIR;

  try {
    // Get script paths from configuration.yaml
    const { scriptPaths } = await getConfigFilePaths(targetPath);

    // Process only script files
    for (const filePath of scriptPaths) {
      try {
        // Check if file exists before trying to read it
        let fileStats;
        try {
          fileStats = await fs.promises.stat(filePath);
        } catch (e) {
          continue; // Skip non-existent files
        }

        const content = await fs.promises.readFile(filePath, 'utf-8');
        const fileLines = content.split(/\r\n?|\n/);
        const data = yaml.load(content);

        if (data) {
          // Ensure the file path is relative to configPath for Git operations
          const relativeToConfigPath = path.relative(configPath, filePath);
          const mtime = fileStats.mtimeMs;

          // Check if scripts is wrapped in a 'scripts' key (array or object)
          if (data.scripts) {
            if (Array.isArray(data.scripts)) {
              data.scripts.forEach((script, index) => {
                if (script.alias) {
                  // Use UUID if available, then fallback to alias, then index
                  // Format: scripts:FILE:UUID_OR_ALIAS_OR_INDEX
                  const uniqueId = script.id || script.alias || index;
                  scripts.push({
                    id: `scripts:${encodeURIComponent(relativeToConfigPath)}:${uniqueId}`,
                    rawId: script.id,
                    name: script.alias,
                    type: 'script',
                    file: relativeToConfigPath, // Store relative path
                    index: index,
                    content: script,
                    line: findStartLine(fileLines, script),
                    fullPath: filePath,
                    mtime: mtime
                  });
                }
              });
            } else {
              // Object format
              Object.keys(data.scripts).forEach(scriptName => {
                const script = data.scripts[scriptName];
                const uniqueId = script.id || script.alias || scriptName;
                scripts.push({
                  id: `scripts:${encodeURIComponent(relativeToConfigPath)}:${uniqueId}`,
                  rawId: script.id,
                  name: scriptName,
                  type: 'script',
                  file: relativeToConfigPath, // Store relative path
                  key: scriptName,
                  content: data.scripts[scriptName],
                  line: findStartLine(fileLines, data.scripts[scriptName]),
                  fullPath: filePath,
                  mtime: mtime
                });
              });
            }
          } else {
            // Standard Home Assistant format: scripts at root level
            // Check if this looks like a script by checking for script-specific properties
            Object.keys(data).forEach(key => {
              const script = data[key];
              // Skip comments and other non-object entries
              if (script && typeof script === 'object' && script.alias) {
                // Scripts have sequence
                // Automations have triggers (or trigger) and/or conditions
                const hasTriggers = script.triggers || script.trigger;
                const hasSequence = script.sequence;

                // If it has sequence but NOT triggers, it's a script
                if (hasSequence && !hasTriggers) {
                  const uniqueId = script.id || script.alias || key;
                  scripts.push({
                    id: `scripts:${encodeURIComponent(relativeToConfigPath)}:${uniqueId}`,
                    rawId: script.id,
                    name: script.alias || key,
                    type: 'script',
                    file: relativeToConfigPath, // Store relative path
                    key: key,
                    content: script,
                    line: findStartLine(fileLines, script),
                    fullPath: filePath,
                    mtime: mtime
                  });
                }
              }
            });
          }
        }
      } catch (error) {
        // Skip invalid YAML files
        console.log(`Skipping ${filePath}: invalid YAML`);
      }
    }

  } catch (error) {
    console.error('Error extracting scripts:', error);
  }

  return scripts;
}

/**
 * Scan all YAML files in the directory
 * @param {string} rootDir - Root directory to scan
 * @returns {Array} List of full file paths
 */
async function scanAllYamlFiles(rootDir) {
  const yamlFiles = [];
  rootDir = rootDir || BASE_DIR;

  try {
    const entries = await fs.promises.readdir(rootDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.yaml')) {
        yamlFiles.push(path.join(rootDir, entry.name));
      }
    }
  } catch (error) {
    // Ignore
  }

  // Check packages directory
  const packagesDir = path.join(BASE_DIR, 'packages');
  try {
    const entries = await fs.promises.readdir(packagesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.yaml')) {
        yamlFiles.push(path.join(packagesDir, entry.name));
      }
    }
  } catch (error) {
    // Packages directory might not exist
  }

  return yamlFiles;
}

/**
 * Find all YAML files that might contain automations or scripts
 * @param {string} type - Type of file to search for
 * @returns {Array} List of file paths
 */
async function findYamlFiles(type) {
  const files = [];

  // Known files
  const knownFiles = [
    path.join(BASE_DIR, `${type}.yaml`),
    path.join(BASE_DIR, `${type}.yml`),
    path.join(BASE_DIR, 'test-config.yaml')  // Include test file
  ];

  // Check packages directory
  const packagesDir = path.join(BASE_DIR, 'packages');
  try {
    const entries = await fs.promises.readdir(packagesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.yaml')) {
        knownFiles.push(path.join(packagesDir, entry.name));
      }
    }
  } catch (error) {
    // Packages directory might not exist
  }

  // Also scan root directory for any YAML file
  const rootDir = BASE_DIR;
  try {
    const entries = await fs.promises.readdir(rootDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.yaml')) {
        const fullPath = path.join(rootDir, entry.name);
        if (!knownFiles.includes(fullPath)) {
          knownFiles.push(fullPath);
        }
      }
    }
  } catch (error) {
    // Ignore
  }

  return knownFiles;
}

/**
 * Get the history of changes for a specific automation
 * @param {string} automationId - The automation ID
 * @param {string} configPath - The config path
 * @param {Object} options - Optional parameters
 * @returns {Array} List of commits that affected this automation
 */
export async function getAutomationHistory(automationId, configPath, options = {}) {
  const { filePath: gitFilePath, identifier } = parseId(automationId);
  const commits = [];
  const debugMessages = [];

  debugMessages.push(`[getAutomationHistory] Searching history for file: ${gitFilePath}, identifier: ${identifier}`);
  debugMessages.push(`[getAutomationHistory] Using Git base directory: ${configPath}`);

  try {
    const isRepo = await gitCheckIsRepo();
    if (!isRepo) {
      debugMessages.push(`[getAutomationHistory] ERROR: ${configPath} is NOT a Git repository.`);
      return { success: false, history: [], debugMessages };
    }
    debugMessages.push(`[getAutomationHistory] ${configPath} IS a Git repository.`);

    try {
      // Check if the file is tracked by Git (or WAS tracked)
      // We accept error here because for deleted files, it might fail ls-files check if we don't look carefully,
      // but strictly speaking we just want to look at logs.
      await gitRaw(['ls-files', '--error-unmatch', gitFilePath]);
      debugMessages.push(`[getAutomationHistory] File ${gitFilePath} IS tracked by Git.`);
    } catch (lsFilesError) {
      // If it's a deleted file, it won't be in ls-files. But we can still check log.
      // Only return if log is empty later.
      debugMessages.push(`[getAutomationHistory] File ${gitFilePath} is not currently tracked (might be deleted). Continuing to check logs.`);
    }

    const logOptions = { file: gitFilePath };
    if (options.maxCount) {
      logOptions.maxCount = options.maxCount;
    }
    const log = await gitLog(logOptions);
    debugMessages.push(`[getAutomationHistory] Found ${log.all.length} commits for file ${gitFilePath}`);

    if (log.all.length === 0) {
      debugMessages.push(`[getAutomationHistory] No Git history found for the file: ${gitFilePath}.`);
      return { success: false, history: [], debugMessages };
    }

    let candidate = null;

    for (const commit of log.all) {
      try {
        debugMessages.push(`[getAutomationHistory] Checking commit: ${commit.hash.substring(0, 7)} - ${commit.message}`);
        const content = await gitShowFileAtCommit(commit.hash, gitFilePath);

        const data = yaml.load(content);

        let auto = null;
        if (data) {
          if (data.automations) {
            auto = findItemByIdentifier(data.automations, identifier, Array.isArray(data.automations));
            debugMessages.push(`[getAutomationHistory] Array/Object lookup for ${identifier}: ${!!auto}`);
          } else {
            // Standard Home Assistant format (root level array or object)
            auto = findItemByIdentifier(data, identifier, Array.isArray(data));
            debugMessages.push(`[getAutomationHistory] Root lookup for ${identifier}: ${!!auto}`);
          }
        } else {
          debugMessages.push(`[getAutomationHistory] No YAML data parsed from file at commit ${commit.hash.substring(0, 7)}`);
        }

        if (auto) {
          const currentCommitObj = {
            hash: commit.hash,
            date: commit.date,
            message: commit.message,
            author: commit.author_name,
            automation: auto
          };

          if (!candidate) {
            // First relevant commit encountered (newest)
            candidate = currentCommitObj;
          } else {
            if (JSON.stringify(candidate.automation) === JSON.stringify(auto)) {
              // Same content, found an older version. Update candidate to older.
              // usage: older commit is better represents "when this state started"
              candidate = currentCommitObj;
              debugMessages.push(`[getAutomationHistory] Same content found in older commit ${commit.hash.substring(0, 7)}. Updating candidate.`);
            } else {
              // Content changed. The PREVIOUS candidate was the start of the newer block.
              commits.push(candidate);
              debugMessages.push(`[getAutomationHistory] Content changed in commit ${commit.hash.substring(0, 7)}. Pushing previous candidate.`);
              candidate = currentCommitObj;
            }
          }
        } else {
          // Automation missing in this commit.
          // If we had a candidate, it means the automation was CREATED at the candidate commit.
          if (candidate) {
            commits.push(candidate);
            candidate = null;
            debugMessages.push(`[getAutomationHistory] Automation missing in commit ${commit.hash.substring(0, 7)}. Last candidate was creation point.`);
          }
        }

      } catch (error) {
        debugMessages.push(`[getAutomationHistory] Error processing commit ${commit.hash.substring(0, 7)} for file ${gitFilePath}: ${error.message}`);
        // If error (e.g. file didn't exist), treat as missing? 
        // Safer to just ignore and keep candidate if we suspect transient error, but generally gitShowFileAtCommit throws if file missing.
        if (candidate) {
          commits.push(candidate);
          candidate = null;
        }
      }
    }

    if (candidate) {
      commits.push(candidate);
      debugMessages.push(`[getAutomationHistory] Pushing final candidate (oldest).`);
    }

    debugMessages.push(`[getAutomationHistory] Total automations found in history: ${commits.length}`);
  } catch (error) {
    debugMessages.push(`[getAutomationHistory] Critical error getting automation history: ${error.message}`);
    return { success: false, history: [], debugMessages };
  }

  return { success: commits.length > 0, history: commits, debugMessages };
}

/**
 * Get just the commit metadata for an automation's file (fast, no YAML parsing)
 * This enables progressive loading by returning commit list quickly
 * @param {string} automationId - The automation ID
 * @param {string} configPath - The config path
 * @param {Object} options - Optional parameters
 * @returns {Object} List of commit metadata (hash, date, message)
 */
export async function getAutomationHistoryMetadata(automationId, configPath, options = {}) {
  const { filePath: gitFilePath, identifier } = parseId(automationId);

  try {
    const isRepo = await gitCheckIsRepo();
    if (!isRepo) {
      return { success: false, commits: [], error: 'Not a Git repository' };
    }

    const logOptions = { file: gitFilePath };
    if (options.maxCount) {
      logOptions.maxCount = options.maxCount;
    }
    const log = await gitLog(logOptions);

    if (log.all.length === 0) {
      return { success: false, commits: [], error: 'No history found' };
    }

    // Return just the metadata without parsing content
    const commits = log.all.map(commit => ({
      hash: commit.hash,
      date: commit.date,
      message: commit.message,
      author: commit.author_name
    }));

    return {
      success: true,
      commits,
      identifier,
      gitFilePath
    };
  } catch (error) {
    console.error('[getAutomationHistoryMetadata] Error:', error);
    return { success: false, commits: [], error: error.message };
  }
}

/**
 * Get a specific automation's content at a specific commit
 * @param {string} automationId - The automation ID  
 * @param {string} commitHash - The commit hash
 * @param {string} configPath - The config path
 * @returns {Object} The automation content at that commit
 */
export async function getAutomationAtCommit(automationId, commitHash, configPath) {
  const { filePath: gitFilePath, identifier } = parseId(automationId);

  try {
    const content = await gitShowFileAtCommit(commitHash, gitFilePath);
    const data = yaml.load(content);

    if (!data) {
      return { success: false, automation: null, error: 'No YAML data' };
    }

    let auto = null;
    if (data.automations) {
      auto = findItemByIdentifier(data.automations, identifier, Array.isArray(data.automations));
    } else {
      auto = findItemByIdentifier(data, identifier, Array.isArray(data));
    }

    return { success: !!auto, automation: auto };
  } catch (error) {
    console.error(`[getAutomationAtCommit] Error at commit ${commitHash}:`, error);
    return { success: false, automation: null, error: error.message };
  }
}

/**
 * Get just the commit metadata for a script's file (fast, no YAML parsing)
 * @param {string} scriptId - The script ID
 * @param {string} configPath - The config path
 * @param {Object} options - Optional parameters
 * @returns {Object} List of commit metadata
 */
export async function getScriptHistoryMetadata(scriptId, configPath, options = {}) {
  const { filePath: gitFilePath, identifier } = parseId(scriptId);

  try {
    const isRepo = await gitCheckIsRepo();
    if (!isRepo) {
      return { success: false, commits: [], error: 'Not a Git repository' };
    }

    const logOptions = { file: gitFilePath };
    if (options.maxCount) {
      logOptions.maxCount = options.maxCount;
    }
    const log = await gitLog(logOptions);

    if (log.all.length === 0) {
      return { success: false, commits: [], error: 'No history found' };
    }

    const commits = log.all.map(commit => ({
      hash: commit.hash,
      date: commit.date,
      message: commit.message,
      author: commit.author_name
    }));

    return {
      success: true,
      commits,
      identifier,
      gitFilePath
    };
  } catch (error) {
    console.error('[getScriptHistoryMetadata] Error:', error);
    return { success: false, commits: [], error: error.message };
  }
}

/**
 * Get a specific script's content at a specific commit
 * @param {string} scriptId - The script ID
 * @param {string} commitHash - The commit hash
 * @param {string} configPath - The config path
 * @returns {Object} The script content at that commit
 */
export async function getScriptAtCommit(scriptId, commitHash, configPath) {
  const { filePath: gitFilePath, identifier } = parseId(scriptId);

  try {
    const content = await gitShowFileAtCommit(commitHash, gitFilePath);
    const data = yaml.load(content);

    if (!data) {
      return { success: false, script: null, error: 'No YAML data' };
    }

    let script = null;
    if (data.scripts) {
      script = findItemByIdentifier(data.scripts, identifier, Array.isArray(data.scripts));
    } else {
      script = findItemByIdentifier(data, identifier, Array.isArray(data));
    }

    return { success: !!script, script };
  } catch (error) {
    console.error(`[getScriptAtCommit] Error at commit ${commitHash}:`, error);
    return { success: false, script: null, error: error.message };
  }
}

/**
 * Get the history of changes for a specific script
 * @param {string} scriptId - The script ID
 * @param {string} configPath - The config path
 * @param {Object} options - Optional parameters
 * @returns {Array} List of commits that affected this script
 */
export async function getScriptHistory(scriptId, configPath, options = {}) {
  const { filePath: gitFilePath, identifier } = parseId(scriptId);
  const commits = [];
  const debugMessages = [];

  debugMessages.push(`[getScriptHistory] Searching history for file: ${gitFilePath}, identifier: ${identifier}`);
  debugMessages.push(`[getScriptHistory] Using Git base directory: ${configPath}`);

  try {
    const isRepo = await gitCheckIsRepo();
    if (!isRepo) {
      debugMessages.push(`[getScriptHistory] ERROR: ${configPath} is NOT a Git repository.`);
      return { success: false, history: [], debugMessages };
    }
    debugMessages.push(`[getScriptHistory] ${configPath} IS a Git repository.`);

    try {
      // Check if the file is tracked by Git
      await gitRaw(['ls-files', '--error-unmatch', gitFilePath]);
      debugMessages.push(`[getScriptHistory] File ${gitFilePath} IS tracked by Git.`);
    } catch (lsFilesError) {
      debugMessages.push(`[getScriptHistory] File ${gitFilePath} is not currently tracked (might be deleted). Continuing to check logs.`);
    }

    const logOptions = { file: gitFilePath };
    if (options.maxCount) {
      logOptions.maxCount = options.maxCount;
    }
    const log = await gitLog(logOptions);
    debugMessages.push(`[getScriptHistory] Found ${log.all.length} commits for file ${gitFilePath}`);

    if (log.all.length === 0) {
      debugMessages.push(`[getScriptHistory] No Git history found for the file: ${gitFilePath}.`);
      return { success: false, history: [], debugMessages };
    }

    let candidate = null;

    for (const commit of log.all) {
      try {
        debugMessages.push(`[getScriptHistory] Checking commit: ${commit.hash.substring(0, 7)} - ${commit.message}`);
        const content = await gitShowFileAtCommit(commit.hash, gitFilePath);

        const data = yaml.load(content);

        let script = null;
        if (data) {
          if (data.scripts) {
            script = findItemByIdentifier(data.scripts, identifier, Array.isArray(data.scripts));
            debugMessages.push(`[getScriptHistory] Array/Object lookup for ${identifier}: ${!!script}`);
          } else {
            // Standard Home Assistant format (root level array or object)
            script = findItemByIdentifier(data, identifier, Array.isArray(data));
            debugMessages.push(`[getScriptHistory] Root lookup for ${identifier}: ${!!script}`);
          }
        } else {
          debugMessages.push(`[getScriptHistory] No YAML data parsed from file at commit ${commit.hash.substring(0, 7)}`);
        }

        if (script) {
          const currentCommitObj = {
            hash: commit.hash,
            date: commit.date,
            message: commit.message,
            author: commit.author_name,
            script: script
          };

          if (!candidate) {
            candidate = currentCommitObj;
          } else {
            if (JSON.stringify(candidate.script) === JSON.stringify(script)) {
              // Same content, update candidate to older commit
              candidate = currentCommitObj;
              debugMessages.push(`[getScriptHistory] Same content found in older commit ${commit.hash.substring(0, 7)}. Updating candidate.`);
            } else {
              // Content changed
              commits.push(candidate);
              debugMessages.push(`[getScriptHistory] Content changed in commit ${commit.hash.substring(0, 7)}. Pushing previous candidate.`);
              candidate = currentCommitObj;
            }
          }
        } else {
          // Script missing
          if (candidate) {
            commits.push(candidate);
            candidate = null;
            debugMessages.push(`[getScriptHistory] Script missing in commit ${commit.hash.substring(0, 7)}. Last candidate was creation point.`);
          }
          debugMessages.push(`[getScriptHistory] Script NOT found in commit ${commit.hash.substring(0, 7)} with identifier ${identifier}`);
        }
      }
      catch (error) {
        debugMessages.push(`[getScriptHistory] Error processing commit ${commit.hash.substring(0, 7)} for file ${gitFilePath}: ${error.message}`);
        if (candidate) {
          commits.push(candidate);
          candidate = null;
        }
      }
    }

    if (candidate) {
      commits.push(candidate);
      debugMessages.push(`[getScriptHistory] Pushing final candidate (oldest).`);
    }

    debugMessages.push(`[getScriptHistory] Total scripts found in history: ${commits.length}`);
  }
  catch (error) {
    debugMessages.push(`[getScriptHistory] Critical error getting script history: ${error.message}`);
    return { success: false, history: [], debugMessages };
  }

  return { success: commits.length > 0, history: commits, debugMessages };
}

/**
 * Get the diff for a specific version of an automation
 * @param {string} automationId - The automation ID
 * @param {string} commitHash - The commit hash
 * @returns {string} The diff
 */
export async function getAutomationDiff(automationId, commitHash, configPath) {
  const { filePath: gitFilePath } = parseId(automationId);
  const prevHash = `${commitHash}^`;

  try {
    const currentContent = await gitShowFileAtCommit(commitHash, gitFilePath);
    const prevContent = await gitShowFileAtCommit(prevHash, gitFilePath);

    const diff = await gitDiff([`${prevHash}`, commitHash, '--', gitFilePath]);
    return diff;
  } catch (error) {
      console.error('Error getting automation diff:', error);
    return null;
  }
}

/**
 * Get the diff for a specific version of a script
 * @param {string} scriptId - The script ID
 * @param {string} commitHash - The commit hash
 * @returns {string} The diff
 */
export async function getScriptDiff(scriptId, commitHash, configPath) {
  const { filePath: gitFilePath } = parseId(scriptId);
  const prevHash = `${commitHash}^`;

  try {
    const diff = await git.diff([`${prevHash}`, commitHash, '--', gitFilePath]);
    return diff;
  } catch (error) {
    console.error('Error getting script diff:', error);
    return null;
  }
}

/**
 * Helper to get a specific automation/script object from a file's content at a given commit.
 * This logic is duplicated from getAutomationHistory/getScriptHistory but is needed here.
 */
async function getAutomationOrScriptFromContent(content, identifier, type) {
  const data = yaml.load(content);
  if (!data) return null;

  let item = null;
  const key = type === 'automation' ? 'automations' : 'scripts';

  if (data[key]) {
    item = findItemByIdentifier(data[key], identifier, Array.isArray(data[key]));
  } else {
    // Root
    item = findItemByIdentifier(data, identifier, Array.isArray(data));
  }
  return item;
}

/**
 * Restore an automation to a specific version
 * @param {string} automationId - The automation ID
 * @param {string} commitHash - The commit hash to restore to
 * @param {string} configPath - The base directory for Git operations
 * @returns {boolean} Success status
 */
export async function restoreAutomation(automationId, commitHash, configPath) {
  const { filePath: gitFilePath, identifier } = parseId(automationId);
  const absFilePath = path.join(configPath, gitFilePath);

  try {
    // 1. Get the date from the commit for the commit message
    const commitDetails = await gitLog({ maxCount: 1 });
    const commitDate = new Date(commitDetails.all[0]?.date || Date.now()).toLocaleString();

    // 2. Get the restored automation object from the specified commit
    const committedFileContent = await gitShowFileAtCommit(commitHash, gitFilePath);

    // Helper to find by ID or Key/Index (duplicated from getAutomationHistory to stay self-contained)
    const findAutomation = (collection, isArray) => {
      if (isArray) {
        const found = collection.find(item => item && item.id === identifier);
        if (found) return found;
        if (!isNaN(parseInt(identifier))) {
          return collection[parseInt(identifier)];
        }
      } else {
        const found = Object.values(collection).find(item => item && item.id === identifier);
        if (found) return found;
        return collection[identifier];
      }
      return null;
    };

    const data = yaml.load(committedFileContent);
    let restoredAutomation = null;
    if (data) {
      if (data.automations) {
        restoredAutomation = findAutomation(data.automations, Array.isArray(data.automations));
      } else {
        restoredAutomation = findAutomation(data, Array.isArray(data));
      }
    }

    if (!restoredAutomation) {
      console.error(`[restoreAutomation] Could not find automation ${identifier} in commit ${commitHash} of file ${gitFilePath}`);
      return false;
    }

    // 3. Get the current content of the file from disk (or create empty if new/deleted)
    let currentFileContent = '';
    try {
      currentFileContent = await fs.promises.readFile(absFilePath, 'utf-8');
    } catch (e) {
      // File might not exist (if it was deleted), we can try to recreate or error.
      // For simple restore of an item into an existing system, assuming file exists is safer unless we implement full file restore.
      // If file doesn't exist, we probably should create it with basic structure?
      // But if it's the "deleted items" flow, the file itself might be deleted? 
      // No, automations.yaml usually exists. If it's a split config file, it might be gone.
      // If file is missing, initialize as empty object/array depending on type?
      console.log(`[restoreAutomation] File ${absFilePath} not found, initializing new`);
      currentFileContent = '';
    }

    let currentData = yaml.load(currentFileContent) || (Array.isArray(data.automations || data) ? [] : {});

    // 4. Locate and add/replace the specific automation in the current data structure
    // We need to match where to put it. 
    // If it's automations.yaml (root array), we append or replace.
    // If it's split config, it depends on structure.

    // Naive approach: try to find matching ID in current data to replace, else append.

    // Determine container key
    const key = data.automations ? 'automations' : null;
    let targetContainer = key ? currentData[key] : currentData;

    if (!targetContainer) {
      // Initialize if missing
      if (key) {
        currentData[key] = [];
        targetContainer = currentData[key];
      } else {
        // Root level, currentData is the container
      }
    }

    if (Array.isArray(targetContainer)) {
      // Array: find index of existing item with same ID
      const existingIndex = targetContainer.findIndex(item => item.id === restoredAutomation.id || item.id === identifier); // Check both UUID and original identifier if it was UUID

      if (existingIndex >= 0) {
        targetContainer[existingIndex] = restoredAutomation;
        console.log(`[restoreAutomation] Replaced existing automation at index ${existingIndex}`);
      } else {
        targetContainer.push(restoredAutomation);
        console.log(`[restoreAutomation] Appended new automation`);
      }
    } else {
      // Object: use identifier (or UUID) as key? 
      // If restoredAutomation has an ID, use that as key? Or use the original key?
      // In object format, key IS the ID usually.
      // If identifier was UUID, we need a key. 
      // If we found it via UUID, we don't know the original key unless we stored it?
      // In getAutomationHistory we return 'automation' object. We didn't preserve the Key in the history object explicitly in getAutomationHistory return, 
      // but extractAutomations stores it.
      // For restore, we are getting `restoredAutomation` from YAML. 
      // If object format, we need the Key. 
      // Refactor of `findAutomation` to return { key, value } might be cleaner?
      // uniqueId logic: auto.id || autoName.

      // Let's rely on `identifier` being the key if it's not a UUID, or `restoredAutomation.alias` normalized?
      // Fallback: use identifier.
      // NOTE: If identifier is UUID, using it as key in `automations: { UUID: ... }` is valid but might not be user preference (usually slug).
      // Use `restoredAutomation.id` or `identifier`.
      const targetKey = restoredAutomation.id || identifier;
      targetContainer[targetKey] = restoredAutomation;
    }

    // 5. Dump the modified data back to YAML
    const updatedYaml = yaml.dump(currentData, {
      indent: 2,
      lineWidth: -1,  // Don't wrap lines
      noRefs: true,   // Don't use references
      sortKeys: false // Keep key order
    });

    // 6. Write the updated YAML back to the file
    // Ensure directory exists
    await fs.promises.mkdir(path.dirname(absFilePath), { recursive: true });
    await fs.promises.writeFile(absFilePath, updatedYaml);
    console.log(`[restoreAutomation] ✓ Automation '${identifier}' restored from ${commitDate}`);

    return true;
  } catch (error) {
    console.error('[restoreAutomation] Error:', error);
    return false;
  }
}

/**
 * Restore a script to a specific version
 * @param {string} scriptId - The script ID
 * @param {string} commitHash - The commit hash to restore to
 * @param {string} configPath - The base directory for Git operations
 * @returns {boolean} Success status
 */
export async function restoreScript(scriptId, commitHash, configPath) {
  const { filePath: gitFilePath, identifier } = parseId(scriptId);
  const absFilePath = path.join(configPath, gitFilePath);

  try {
    // 1. Get the date from the commit for the commit message
    const commitDetails = await gitLog({ maxCount: 1 });
    const commitDate = new Date(commitDetails.all[0]?.date || Date.now()).toLocaleString();

    // 2. Get the restored script object from the specified commit
    const committedFileContent = await gitShowFileAtCommit(commitHash, gitFilePath);
    const restoredScript = await getAutomationOrScriptFromContent(committedFileContent, identifier, 'script');

    if (!restoredScript) {
      console.error(`[restoreScript] Could not find script ${identifier} in commit ${commitHash} of file ${gitFilePath}`);
      return false;
    }

    // 3. Get the current content of the file from disk (or initialize empty if missing)
    let currentFileContent = '';
    try {
      currentFileContent = await fs.promises.readFile(absFilePath, 'utf-8');
    } catch (e) {
      console.log(`[restoreScript] File ${absFilePath} not found, initializing new`);
      currentFileContent = '';
    }

    let currentData = yaml.load(currentFileContent) || {};

    // 4. Locate and add/replace the specific script in the current data structure
    const key = 'scripts'; // Assuming scripts are under 'scripts' key or root

    if (currentData[key]) {
      if (Array.isArray(currentData[key])) {
        // Replace by index for array-based scripts
        const index = parseInt(identifier);
        if (index >= 0 && index < currentData[key].length) {
          // Replace existing script
          currentData[key][index] = restoredScript;
        } else {
          // Index out of bounds - append the script instead
          currentData[key].push(restoredScript);
        }
      } else {
        // Replace by key for object-based scripts
        currentData[key][identifier] = restoredScript;
      }
    } else {
      // Root-level script
      currentData[identifier] = restoredScript;
    }

    // 5. Dump the modified data back to YAML
    const updatedYaml = yaml.dump(currentData, {
      indent: 2,
      lineWidth: -1,  // Don't wrap lines
      noRefs: true,   // Don't use references
      sortKeys: false // Keep key order
    });

    // 6. Write the updated YAML back to the file
    await fs.promises.mkdir(path.dirname(absFilePath), { recursive: true });
    await fs.promises.writeFile(absFilePath, updatedYaml);
    console.log(`[restoreScript] ✓ Script '${identifier}' restored from ${commitDate}`);
    console.log(`[restoreScript] ✓ File watcher will auto-commit this change`);

    return true;
  } catch (error) {
    console.error('[restoreScript] Error:', error);
    return false;
  }
}
