'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn: spawnChild } = require('node:child_process');
const { parseArgs } = require('node:util');

function resolveCodexPath({ nodePath = process.execPath, envPath = process.env.PATH || '', platform = process.platform } = {}) {
  if (typeof nodePath !== 'string' || !path.isAbsolute(nodePath) || typeof envPath !== 'string') {
    throw new Error('Codex discovery requires an absolute Node path and a string PATH.');
  }
  const cli = path.join('@openai', 'codex', 'bin', 'codex.js');
  const directories = [path.dirname(nodePath), ...envPath.split(platform === 'win32' ? ';' : ':')]
    .map((directory) => directory.replace(/^"(.*)"$/, '$1'))
    .filter((directory) => directory && !directory.includes('\0') && path.isAbsolute(directory));
  for (const directory of new Set(directories)) {
    const candidates = [path.join(directory, 'node_modules', cli)];
    if (platform !== 'win32') {
      candidates.push(path.join(directory, '..', 'lib', 'node_modules', cli));
      try {
        const launcher = path.join(directory, 'codex');
        if (fs.lstatSync(launcher).isSymbolicLink()) {
          const target = fs.realpathSync(launcher);
          if (target.endsWith(`${path.sep}${cli}`)) candidates.push(target);
        }
      } catch {}
    }
    for (const candidate of candidates) {
      try {
        if (fs.statSync(candidate).isFile()) return fs.realpathSync(candidate);
      } catch {}
    }
  }
  throw new Error('Codex npm CLI was not found. Run npm install -g @openai/codex and ensure its install directory is on the same PATH as Node and Claude Code.');
}

function buildArgs({ cwd, sandbox, resultFile }) {
  return [
    '--ask-for-approval', 'never', 'exec', '--cd', cwd, '--sandbox', sandbox,
    '--disable', 'multi_agent', '--disable', 'multi_agent_v2',
    '--skip-git-repo-check', '--json', '--color', 'never',
    '--output-last-message', resultFile, '-',
  ];
}

function workerPrompt(task) {
  return `You are a Codex worker delegated by Claude Code. Claude owns planning and final verification.
Complete only the assigned task and permitted file scope. Do not spawn subagents or call Claude.
Read the applicable project AGENTS.md and CLAUDE.md before editing. Preserve existing user changes.
If applicable and installed, read the antislop core and relevant skills. Honor an explicit antislop mode included in the assigned task; otherwise follow the skill's normal mode resolution. For UI work, follow the supplied design direction and run the applicable delivery checks.
Do not commit, push, publish, deploy, or broaden permissions unless this task explicitly authorizes it. Report sandbox restrictions instead of bypassing them.
Return a concise report with changed files, the commands actually run and their results, unfinished work, and risks. Never claim verification you did not perform.

Assigned task:
${task.trim()}
`;
}

function logTail(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const length = fs.fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(length, 8000));
    fs.readSync(fd, buffer, 0, buffer.length, length - buffer.length);
    return buffer.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

async function runWorker({ cwd, sandbox = 'read-only', task }, dependencies = {}) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new Error('--cwd must be an existing absolute directory.');
  }
  if (!['read-only', 'workspace-write'].includes(sandbox)) {
    throw new Error('--sandbox must be read-only or workspace-write.');
  }
  if (typeof task !== 'string' || !task.trim()) {
    throw new Error('Provide a nonempty task on stdin.');
  }
  const codexPath = dependencies.codexPath || resolveCodexPath();
  if (!fs.existsSync(codexPath)) {
    throw new Error(`Codex CLI was not found: ${codexPath}`);
  }
  const runsRoot = dependencies.runsRoot || path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'codex-workers');
  const runDir = path.join(runsRoot, `${Date.now()}-${randomUUID()}`);
  fs.mkdirSync(runDir, { recursive: true });
  const resultFile = path.join(runDir, 'result.md');
  const stderrFile = path.join(runDir, 'stderr.log');
  const statusFile = path.join(runDir, 'status.json');
  const status = { status: 'running', cwd, sandbox, startedAt: new Date().toISOString() };
  const saveStatus = () => fs.writeFileSync(statusFile, `${JSON.stringify(status, null, 2)}\n`);
  saveStatus();
  process.stdout.write(`[codex-worker] Run directory: ${runDir}\n`);

  const eventsFd = fs.openSync(path.join(runDir, 'events.jsonl'), 'w');
  const stderrFd = fs.openSync(stderrFile, 'w');
  let child;
  let interrupted;
  let spawnError;
  let outcome;
  const interrupt = (signal) => {
    interrupted = signal;
    if (!child || !child.pid) return;
    if (process.platform === 'win32') {
      // Terminate the Node launcher and its Codex child together.
      spawnChild('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true, stdio: 'ignore',
      }).on('error', () => child.kill(signal));
    } else {
      child.kill(signal);
    }
  };
  const onInt = () => interrupt('SIGINT');
  const onTerm = () => interrupt('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  try {
    child = (dependencies.spawn || spawnChild)(process.execPath, [
      codexPath, ...buildArgs({ cwd, sandbox, resultFile }),
    ], { cwd, shell: false, windowsHide: true, stdio: ['pipe', eventsFd, stderrFd] });
    outcome = await new Promise((resolve) => {
      child.on('error', (error) => { spawnError = error; });
      child.on('close', (code, signal) => resolve({ code, signal }));
      child.stdin.on('error', (error) => { spawnError = error; });
      child.stdin.end(workerPrompt(task), 'utf8');
    });
  } catch (error) {
    spawnError = error;
    outcome = { code: 1, signal: null };
    if (child && child.pid) interrupt('SIGTERM');
  } finally {
    process.removeListener('SIGINT', onInt);
    process.removeListener('SIGTERM', onTerm);
    fs.closeSync(eventsFd);
    fs.closeSync(stderrFd);
  }

  const report = fs.existsSync(resultFile) ? fs.readFileSync(resultFile, 'utf8').trim() : '';
  const succeeded = outcome.code === 0 && !spawnError && !interrupted && Boolean(report);
  const exitCode = succeeded ? 0 : interrupted === 'SIGINT' ? 130 : interrupted ? 143 : outcome.code || 1;
  Object.assign(status, {
    status: succeeded ? 'completed' : 'failed',
    finishedAt: new Date().toISOString(), exitCode,
    signal: interrupted || outcome.signal || null,
  });
  if (!succeeded) status.error = spawnError?.message || (report ? 'Codex execution failed.' : 'Codex did not produce a final report.');
  saveStatus();
  if (report) {
    process.stdout.write(`${succeeded ? '' : '[codex-worker] Partial report (failed):\n'}${report}\n`);
  }
  if (!succeeded) {
    process.stderr.write(`[codex-worker] Failed: ${status.error}\n${logTail(stderrFile)}\nLogs: ${runDir}\n`);
  }
  return { runDir, status: status.status, exitCode, report };
}

if (require.main === module) {
  (async () => {
    const { values } = parseArgs({ options: {
      cwd: { type: 'string' }, sandbox: { type: 'string', default: 'read-only' },
    }, strict: true, allowPositionals: false });
    const task = fs.readFileSync(0, 'utf8');
    process.exitCode = (await runWorker({ cwd: values.cwd, sandbox: values.sandbox, task })).exitCode;
  })().catch((error) => {
    process.stderr.write(`[codex-worker] ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { resolveCodexPath, buildArgs, workerPrompt, runWorker };
