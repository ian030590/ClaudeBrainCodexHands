const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { parseArgs } = require('node:util');

const projectName = 'ClaudeBrainCodexHands';
const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function validateSettings(settings) {
  if (!object(settings)) throw new Error('settings.json must contain an object.');
  if (settings.hooks === undefined) return;
  if (!object(settings.hooks)) throw new Error('settings.hooks must be an object.');
  for (const [event, entries] of Object.entries(settings.hooks)) {
    if (!Array.isArray(entries) || entries.some(entry => !object(entry)
      || !Array.isArray(entry.hooks) || entry.hooks.some(hook => !object(hook)))) {
      throw new Error(`Invalid hook entries for ${event}; settings were not changed.`);
    }
  }
}

function samePath(a, b) {
  if (typeof a !== 'string' || !path.isAbsolute(a)) return false;
  const normalized = path.normalize(a);
  return process.platform === 'win32'
    ? normalized.toLowerCase() === path.normalize(b).toLowerCase()
    : normalized === path.normalize(b);
}

function install({ configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), uninstall = false } = {}) {
  configDir = path.resolve(configDir);
  const settingsFile = path.join(configDir, 'settings.json');
  const original = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile) : null;
  const settings = original ? JSON.parse(original.toString('utf8').replace(/^\uFEFF/, '')) : {};
  validateSettings(settings);
  const installedDir = path.join(configDir, 'hooks', projectName);
  const hookFile = path.join(installedDir, 'codex-supervisor.cjs');
  const legacyFile = path.join(configDir, 'hooks', 'codex-supervisor.cjs');
  const owned = hook => hook.type === 'command'
    && typeof hook.command === 'string' && /^node(?:\.exe)?$/i.test(path.basename(hook.command))
    && Array.isArray(hook.args) && hook.args.length === 1
    && (samePath(hook.args[0], hookFile) || (!uninstall && samePath(hook.args[0], legacyFile)));

  let removedAny = false;
  for (const event of events) {
    const existing = settings.hooks?.[event] || [];
    const entries = existing.flatMap(entry => {
      const hooks = entry.hooks.filter(hook => !owned(hook));
      if (hooks.length === entry.hooks.length) return [entry];
      removedAny = true;
      return hooks.length ? [{ ...entry, hooks }] : [];
    });
    if (!uninstall) {
      const hook = { type: 'command', command: process.execPath, args: [hookFile], timeout: 10 };
      entries.push(event === 'PreToolUse'
        ? { matcher: '^(Agent|Task|TeamCreate)$', hooks: [{ ...hook, onFailure: 'block' }] }
        : { hooks: [hook] });
    }
    if (entries.length) (settings.hooks ||= {})[event] = entries;
    else if (settings.hooks && existing.length) delete settings.hooks[event];
  }
  if ((!uninstall || removedAny) && settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
  const serialized = `${JSON.stringify(settings, null, 2)}\n`;
  const changed = uninstall ? Boolean(original && removedAny) : !original || serialized !== original.toString('utf8');
  let backupFile = null;
  if (changed && original) {
    const backupDir = path.join(configDir, 'backups', projectName);
    fs.mkdirSync(backupDir, { recursive: true });
    backupFile = path.join(backupDir, `${Date.now()}-${randomUUID()}.json`);
    fs.writeFileSync(backupFile, original, { flag: 'wx' });
  }
  if (!uninstall) {
    fs.mkdirSync(installedDir, { recursive: true });
    for (const name of ['codex-supervisor.cjs', 'codex-worker.cjs']) {
      fs.copyFileSync(path.join(__dirname, '..', 'hooks', name), path.join(installedDir, name));
    }
  }
  if (changed) {
    fs.mkdirSync(configDir, { recursive: true });
    const temporary = `${settingsFile}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, serialized, { flag: 'wx' });
      fs.renameSync(temporary, settingsFile);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
  return { configDir, settingsFile, installedDir, backupFile, changed, uninstall };
}

if (require.main === module) {
  try {
    const { values } = parseArgs({ options: {
      uninstall: { type: 'boolean', default: false }, 'config-dir': { type: 'string' },
    }, strict: true, allowPositionals: false });
    console.log(JSON.stringify(install({ configDir: values['config-dir'], uninstall: values.uninstall }), null, 2));
  } catch (error) {
    console.error(`Installer failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { install };
