const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const { hookResponse } = require('./codex-supervisor.cjs');
const { resolveCodexPath, buildArgs, workerPrompt, runWorker } = require('./codex-worker.cjs');

test('Codex discovery supports Node-adjacent installs, Windows npm prefixes, and Unix global lib installs', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-discovery-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const makeCli = (prefix) => {
    const cli = path.join(prefix, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    fs.writeFileSync(cli, '// fixture\n');
    return cli;
  };
  const nodeDirectory = path.join(root, 'node');
  const nodePath = path.join(nodeDirectory, 'node.exe');
  const adjacent = makeCli(nodeDirectory);
  const npmPrefix = path.join(root, 'npm prefix with spaces');
  const prefixed = makeCli(npmPrefix);
  fs.writeFileSync(path.join(npmPrefix, 'codex.cmd'), 'This wrapper must never run.');
  const envPath = `relative-entry;"";"${npmPrefix}";${path.join(root, 'absent')}`;
  assert.equal(resolveCodexPath({ nodePath, envPath, platform: 'win32' }), fs.realpathSync(adjacent));
  fs.unlinkSync(adjacent);
  assert.equal(resolveCodexPath({ nodePath, envPath, platform: 'win32' }), fs.realpathSync(prefixed));

  const unixPrefix = path.join(root, 'unix');
  const conventional = makeCli(path.join(unixPrefix, 'lib'));
  assert.equal(resolveCodexPath({
    nodePath: path.join(unixPrefix, 'bin', 'node'), envPath: '', platform: 'linux',
  }), fs.realpathSync(conventional));
  assert.throws(() => resolveCodexPath({ nodePath, envPath: 'relative-entry;\0bad', platform: 'win32' }), /npm install -g @openai\/codex/);
  assert.throws(() => resolveCodexPath({ nodePath: 'relative-node', envPath: '' }), /absolute Node path/);
});

test('Unix PATH symlinks must point to the npm Codex entry point', { skip: process.platform === 'win32' }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-symlink-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const target = path.join(root, 'packages', '@openai', 'codex', 'bin', 'codex.js');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, '// fixture\n');
  const launcher = path.join(bin, 'codex');
  fs.symlinkSync(target, launcher);
  const options = { nodePath: path.join(root, 'node', 'node'), envPath: bin, platform: 'linux' };
  assert.equal(resolveCodexPath(options), fs.realpathSync(target));
  fs.unlinkSync(launcher);
  const arbitrary = path.join(root, 'arbitrary.js');
  fs.writeFileSync(arbitrary, '// must not be selected\n');
  fs.symlinkSync(arbitrary, launcher);
  assert.throws(() => resolveCodexPath(options), /npm install -g @openai\/codex/);
});

test('native agents are denied, while verification and background results are allowed', () => {
  for (const tool_name of ['Agent', 'Task', 'TeamCreate']) {
    const response = hookResponse({ hook_event_name: 'PreToolUse', tool_name });
    assert.equal(response.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(response.hookSpecificOutput.permissionDecisionReason, /no Codex worker has started/);
  }
  for (const tool_name of ['Read', 'Bash', 'TaskOutput', 'TaskCreate', 'TaskUpdate']) {
    assert.equal(hookResponse({ hook_event_name: 'PreToolUse', tool_name }), null);
  }
});

test('session context preserves the plan-mode restriction and refreshes on each prompt', () => {
  for (const hook_event_name of ['SessionStart', 'UserPromptSubmit']) {
    const output = hookResponse({ hook_event_name, permission_mode: 'plan' }).hookSpecificOutput;
    assert.equal(output.hookEventName, hook_event_name);
    assert.match(output.additionalContext, /read-only/);
    assert.match(output.additionalContext, /[Pp]lan mode/);
  }
  const normal = hookResponse({ hook_event_name: 'SessionStart' }).hookSpecificOutput.additionalContext;
  assert.match(normal, /workspace-write/);
  assert.match(normal, /does not inherit your conversation/);
  assert.match(normal, /independently run/);
});

test('the hook returns JSON without noise and fails closed on invalid input', () => {
  const hookFile = path.join(__dirname, 'codex-supervisor.cjs');
  const ok = spawnSync(process.execPath, [hookFile], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Agent' }), encoding: 'utf8',
  });
  assert.equal(ok.status, 0);
  assert.equal(JSON.parse(ok.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(ok.stderr, '');
  const invalid = spawnSync(process.execPath, [hookFile], { input: '{broken', encoding: 'utf8' });
  assert.equal(invalid.status, 2);
  assert.equal(invalid.stdout, '');
});

test('Codex arguments keep approvals global and disable nested agents without overriding the model', () => {
  const args = buildArgs({ cwd: __dirname, sandbox: 'workspace-write', resultFile: 'result.md' });
  assert.deepEqual(args.slice(0, 3), ['--ask-for-approval', 'never', 'exec']);
  assert.equal(args[args.indexOf('--sandbox') + 1], 'workspace-write');
  assert.ok(args.includes('multi_agent'));
  assert.ok(args.includes('multi_agent_v2'));
  assert.ok(!args.includes('--model'));
  assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.match(workerPrompt('task'), /If applicable and installed/);
  assert.doesNotMatch(workerPrompt('task'), /antislop during mode/);
});

test('worker process handles literal Unicode input, logs, failures, and a missing final report', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-supervisor-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project with spaces 中文');
  fs.mkdirSync(project);
  const fakeCli = path.join(root, 'fake-codex.cjs');
  fs.writeFileSync(fakeCli, `
const fs = require('node:fs');
const args = process.argv.slice(2);
const task = fs.readFileSync(0, 'utf8');
console.log(JSON.stringify({type:'test.input', task, args}));
if (task.endsWith('FAIL_TASK\\n')) { process.stderr.write('fixture failure'); process.exit(7); }
if (!task.endsWith('EMPTY_TASK\\n')) {
  fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], 'Fixture report: 中文');
}
`);
  const dependencies = { codexPath: fakeCli, runsRoot: path.join(root, 'runs') };
  const task = '實作 literal $(throw "not executed") and `backticks`';
  const result = await runWorker({ cwd: project, sandbox: 'workspace-write', task }, dependencies);
  assert.equal(result.exitCode, 0);
  assert.equal(result.status, 'completed');
  assert.equal(result.report, 'Fixture report: 中文');
  const logged = JSON.parse(fs.readFileSync(path.join(result.runDir, 'events.jsonl'), 'utf8'));
  assert.ok(logged.task.includes(task));
  assert.equal(logged.args[logged.args.indexOf('--cd') + 1], project);
  assert.equal(JSON.parse(fs.readFileSync(path.join(result.runDir, 'status.json'))).status, 'completed');

  const failure = await runWorker({ cwd: project, task: 'FAIL_TASK' }, dependencies);
  assert.equal(failure.exitCode, 7);
  assert.equal(failure.status, 'failed');
  assert.match(fs.readFileSync(path.join(failure.runDir, 'stderr.log'), 'utf8'), /fixture failure/);
  const empty = await runWorker({ cwd: project, task: 'EMPTY_TASK' }, dependencies);
  assert.equal(empty.exitCode, 1);
  assert.equal(empty.status, 'failed');
  assert.notEqual(result.runDir, empty.runDir);

  await assert.rejects(runWorker({ cwd: project, sandbox: 'danger-full-access', task }, dependencies));
  await assert.rejects(runWorker({ cwd: project, task: ' ' }, dependencies));
  await assert.rejects(runWorker({ cwd: '.', task }, dependencies));
  await assert.rejects(runWorker({ cwd: project, task }, { ...dependencies, codexPath: path.join(root, 'absent') }));
  const spawnFailure = await runWorker({ cwd: project, task }, {
    ...dependencies, spawn() { throw new Error('fixture spawn failure'); },
  });
  assert.equal(spawnFailure.status, 'failed');
  assert.equal(spawnFailure.exitCode, 1);

  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = path.join(root, 'custom claude config');
  try {
    const configured = await runWorker({ cwd: project, task }, { codexPath: fakeCli });
    assert.equal(path.dirname(configured.runDir), path.join(process.env.CLAUDE_CONFIG_DIR, 'codex-workers'));
    assert.equal(configured.status, 'completed');
  } finally {
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
  }
});
