const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { install } = require('./install.cjs');

function temporaryConfig(t) {
  const prefix = path.join(os.tmpdir(), 'ClaudeBrainCodexHands-installer-');
  const root = fs.mkdtempSync(prefix);
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(prefix)));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const configDir = path.join(root, 'config with spaces');
  fs.mkdirSync(configDir);
  return configDir;
}

const readSettings = configDir => JSON.parse(fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8'));

test('install backs up exact bytes, preserves other settings, repeats safely, and uninstalls only its hooks', t => {
  const configDir = temporaryConfig(t);
  const otherHook = { type: 'command', command: 'other-tool', args: ['verify'] };
  const originalSettings = { model: 'example-model', enabledPlugins: { existing: true }, hooks: {
    PreToolUse: [{ matcher: 'Read', hooks: [otherHook], extra: 'preserved' }],
    Stop: [{ hooks: [otherHook] }],
  } };
  const original = Buffer.from(`\uFEFF${JSON.stringify(originalSettings, null, 4)}\r\n`);
  fs.writeFileSync(path.join(configDir, 'settings.json'), original);
  const installed = install({ configDir });
  assert.equal(installed.changed, true);
  assert.deepEqual(fs.readFileSync(installed.backupFile), original);
  for (const file of ['codex-supervisor.cjs', 'codex-worker.cjs']) {
    assert.equal(fs.existsSync(path.join(installed.installedDir, file)), true);
  }
  const settings = readSettings(configDir);
  assert.equal(settings.model, originalSettings.model);
  assert.deepEqual(settings.enabledPlugins, originalSettings.enabledPlugins);
  assert.deepEqual(settings.hooks.PreToolUse[0], originalSettings.hooks.PreToolUse[0]);
  assert.deepEqual(settings.hooks.Stop, originalSettings.hooks.Stop);
  const guard = settings.hooks.PreToolUse[1];
  assert.equal(guard.matcher, '^(Agent|Task|TeamCreate)$');
  assert.equal(guard.hooks[0].onFailure, 'block');
  assert.equal(guard.hooks[0].command, process.execPath);
  assert.deepEqual(guard.hooks[0].args, [path.join(installed.installedDir, 'codex-supervisor.cjs')]);
  const repeat = install({ configDir });
  assert.equal(repeat.changed, false);
  assert.equal(repeat.backupFile, null);
  assert.deepEqual(readSettings(configDir), settings);
  const removed = install({ configDir, uninstall: true });
  assert.equal(removed.changed, true);
  assert.deepEqual(readSettings(configDir), originalSettings);
  assert.equal(fs.existsSync(path.join(installed.installedDir, 'codex-worker.cjs')), true);
});

test('migration removes only the exact legacy script from mixed hook groups', t => {
  const configDir = temporaryConfig(t);
  const legacyFile = path.join(configDir, 'hooks', 'codex-supervisor.cjs');
  const otherFile = path.join(configDir, 'another-package', 'codex-supervisor.cjs');
  const legacy = { type: 'command', command: process.execPath, args: [legacyFile] };
  const other = { ...legacy, args: [otherFile] };
  const otherArguments = { ...legacy, args: [legacyFile, '--custom'] };
  const otherCommand = { ...legacy, command: 'unrelated-tool' };
  const hooks = {};
  for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse']) {
    hooks[event] = [{ matcher: 'custom', hooks: [legacy, other, otherArguments, otherCommand] }];
  }
  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({ hooks }));
  install({ configDir });
  const settings = readSettings(configDir);
  for (const event of Object.keys(hooks)) {
    assert.equal(settings.hooks[event].length, 2);
    assert.deepEqual(settings.hooks[event][0], { matcher: 'custom', hooks: [other, otherArguments, otherCommand] });
    assert.equal(settings.hooks[event][1].hooks.length, 1);
  }
});

test('invalid settings are rejected before backups, copies, or settings writes', t => {
  const configDir = temporaryConfig(t);
  const file = path.join(configDir, 'settings.json');
  for (const text of ['{broken', 'null', '[]', '{"hooks":[]}', '{"hooks":{"Stop":{}}}',
    '{"hooks":{"Stop":[null]}}', '{"hooks":{"Stop":[{"hooks":null}]}}',
    '{"hooks":{"Stop":[{"hooks":["invalid"]}]}}']) {
    fs.writeFileSync(file, text);
    assert.throws(() => install({ configDir }));
    assert.equal(fs.readFileSync(file, 'utf8'), text);
    assert.equal(fs.existsSync(path.join(configDir, 'hooks')), false);
    assert.equal(fs.existsSync(path.join(configDir, 'backups')), false);
  }
});

test('uninstall without an existing settings file does not create one', t => {
  const configDir = temporaryConfig(t);
  assert.equal(install({ configDir, uninstall: true }).changed, false);
  assert.equal(fs.existsSync(path.join(configDir, 'settings.json')), false);
});

test('uninstall with no owned hooks preserves the settings bytes', t => {
  const configDir = temporaryConfig(t);
  const file = path.join(configDir, 'settings.json');
  const original = '{  "model": "example", "hooks": {} }\r\n';
  fs.writeFileSync(file, original);
  const result = install({ configDir, uninstall: true });
  assert.equal(result.changed, false);
  assert.equal(result.backupFile, null);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});
