import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// All git commands run inside CONFIG_PATH
export async function gitExec(args, options = {}) {
    if (!global.CONFIG_PATH) {
        throw new Error('CONFIG_PATH not initialized');
    }
    const { timeout = 30000, env } = options;

    const execOptions = {
        cwd: global.CONFIG_PATH,
        timeout,
        maxBuffer: 10 * 1024 * 1024, // 10 MB
        windowsHide: true
    };

    if (env) {
        execOptions.env = env;
    }

    return execFileAsync('git', args, execOptions);
}

// ──────────────────────────────────────────────────
// Exact replacements for your current simple-git calls
// ──────────────────────────────────────────────────

export async function gitLog(options = {}) {
    // Handle object options if passed (simple-git style)
    let maxCount = 500;
    let file = null;

    if (typeof options === 'object') {
        if (options.maxCount) maxCount = options.maxCount;
        if (options.file) file = options.file;
    } else if (typeof options === 'number') {
        maxCount = options;
    }

    const DELIMITER = '§§§§';
    const COMMIT_DELIMITER = '±±±±';

    // Put delimiter at the START so we can capture the file status that comes after the body
    const args = [
        'log',
        `--max-count=${maxCount}`,
        '--date=iso',
        `--pretty=format:${COMMIT_DELIMITER}%H${DELIMITER}%h${DELIMITER}%an${DELIMITER}%ae${DELIMITER}%at${DELIMITER}%s${DELIMITER}%b`
    ];

    if (file) {
        args.push('--name-status'); // Include file status (A, M, D)
        args.push('--', file);
    }

    const { stdout } = await gitExec(args);

    if (!stdout.trim()) {
        return { all: [], latest: null, total: 0 };
    }

    // Split by delimiter (skip the first empty element if string starts with delimiter)
    const rawCommits = stdout.split(COMMIT_DELIMITER).filter(c => c.trim());

    const commits = rawCommits.map(rawCommit => {
        // The rawCommit string contains the formatted part AND the status lines (if any)
        // We need to separate them. The formatted part ends with the last field (%b)
        // But since %b can contain anything, we rely on the delimiters.

        // Actually, since we split by COMMIT_DELIMITER, rawCommit is:
        // HASH§...§BODY\n\nSTATUS_LINES

        const parts = rawCommit.split(DELIMITER);
        const hash = parts[0] ? parts[0].trim() : '';
        const short = parts[1] ? parts[1].trim() : '';
        const authorName = parts[2] ? parts[2].trim() : '';
        const authorEmail = parts[3] ? parts[3].trim() : '';
        const timestamp = parts[4] ? parts[4].trim() : '';
        const subject = parts[5] ? parts[5].trim() : '';

        // The last part contains BODY + STATUS lines
        let bodyAndStatus = parts[6] || '';
        let body = bodyAndStatus;
        let status = null;

        // If we requested file status, try to extract it
        if (file) {
            // The status line looks like "M\tfilename" or "A\tfilename"
            // It appears after the body, separated by newlines.
            // Since we filtered by specific file, we look for that file's status
            // But simpler: look for the last line that matches status format
            const lines = bodyAndStatus.trim().split('\n');
            const lastLine = lines[lines.length - 1];

            // Check if last line looks like a status line (e.g. "M\tfile.yaml" or "A\tfile.yaml")
            if (lastLine && /^[AMD]\s+/.test(lastLine)) {
                status = lastLine.charAt(0); // 'A', 'M', or 'D'
                // Remove status line from body
                body = lines.slice(0, -1).join('\n').trim();
            }
        }

        return {
            hash,
            short,
            authorName,
            authorEmail,
            date: new Date(parseInt(timestamp) * 1000).toISOString(),
            message: subject,
            body: body.trim(),
            status: status // 'A' = Added, 'M' = Modified, 'D' = Deleted, null = unknown
        };
    });

    return { all: commits, latest: commits[0] || null, total: commits.length };
}

export async function gitStatus() {
    const { stdout } = await gitExec(['status', '--porcelain', '--branch']);
    const lines = stdout.trim().split('\n');
    const files = [];
    let branch = 'master';
    for (const line of lines) {
        if (line.startsWith('##')) {
            branch = line.split(' ')[1]?.split('...')[0] || branch;
            continue;
        }
        if (line.trim() === '') continue;
        const code = line.slice(0, 2);
        const pathStart = line.indexOf(' ') + 1;
        const rawPath = line.slice(pathStart);
        let path = rawPath;
        let oldPath = null;
        if (rawPath.includes(' -> ')) {
            const parts = rawPath.split(' -> ');
            oldPath = parts[0];
            path = parts[1];
        }
        files.push({
            path,
            working_dir: code[1],
            index: code[0],
            oldPath
        });
    }
    return {
        isClean: () => files.length === 0,
        files,
        current: branch,
        conflicted: files.filter(f => f.index === 'C' || f.working_dir === 'C').map(f => f.path)
    };
}

export async function gitShowFileAtCommit(commitHash, filePath) {
    // Properly escape filePath for git (handles spaces, special chars)
    // Actually execFile handles arguments safely, we don't need manual quoting if passed as array arg
    const { stdout } = await gitExec(['show', `${commitHash}:${filePath}`]);
    return stdout;
}

export async function gitCommitDetails(commitHash) {
    const { stdout } = await gitExec(['show', '--name-status', '--oneline', commitHash]);
    return stdout;
}

export async function gitAdd(files) {
    const fileList = Array.isArray(files) ? files : [files];
    await gitExec(['add', ...fileList]);
}

export async function gitCommit(message) {
    await gitExec(['commit', '-m', message]);
}

export async function gitRaw(args) {
    const { stdout } = await gitExec(args);
    return stdout;
}

// Lightweight log for retention cleanup (faster, less parsing)
export async function getLightweightGitLog() {
    const DELIMITER = '§§§§';
    const COMMIT_DELIMITER = '±±±±';

    const { stdout } = await gitExec([
        'log',
        `--pretty=format:%H${DELIMITER}%P${DELIMITER}%aI${DELIMITER}%s${COMMIT_DELIMITER}`,
        '--date-order'
    ]);

    if (!stdout.trim()) {
        return { all: [], total: 0, latest: null };
    }

    const rawCommits = stdout.split(COMMIT_DELIMITER).filter(c => c.trim());

    const commits = rawCommits.map(rawCommit => {
        const parts = rawCommit.split(DELIMITER);
        return {
            hash: parts[0] ? parts[0].trim() : '',
            parents: parts[1] ? parts[1].trim().split(' ') : [],
            date: parts[2] ? parts[2].trim() : '',
            message: parts[3] ? parts[3].trim() : ''
        };
    });

    return { all: commits, total: commits.length, latest: commits[0] || null };
}

// Missing wrappers required by server.js

export async function gitInit() {
    await gitExec(['init']);
}

export async function gitCheckIsRepo() {
    try {
        await gitExec(['rev-parse', '--is-inside-work-tree']);
        return true;
    } catch (e) {
        return false;
    }
}

export async function gitDiff(args) {
    const { stdout } = await gitExec(['diff', ...args]);
    return stdout;
}

export async function gitCheckout(args) {
    await gitExec(['checkout', ...args]);
}

export async function gitBranch(args) {
    if (args) {
        await gitExec(['branch', ...args]);
    } else {
        const { stdout } = await gitExec(['branch']);
        const all = stdout.split('\n').map(b => b.trim().replace('* ', '')).filter(b => b);
        return { all };
    }
}

export async function gitRevparse(args) {
    const { stdout } = await gitExec(['rev-parse', ...args]);
    return stdout.trim();
}

export async function gitRmCached(path) {
    try {
        await gitExec(['rm', '--cached', '-f', path]);
        return true;
    } catch (e) {
        // Ignore errors if file is not in index
        return false;
    }
}

export async function gitResetHead(path) {
    try {
        await gitExec(['reset', 'HEAD', '--', path]);
        return true;
    } catch (e) {
        // Ignore errors if path doesn't exist in HEAD
        return false;
    }
}
