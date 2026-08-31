'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

// Redirect both config families before config.ts captures node:os homedir.
// This test must never read or write the developer's real Claude config.
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'md-claude-config-'));
const home = path.join(base, 'home');
const userData = path.join(base, 'user-data');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(userData, { recursive: true });

const realHome = process.env.HOME;
const realProfile = process.env.USERPROFILE;
process.env.HOME = home;
process.env.USERPROFILE = home;
assert.equal(os.homedir(), home, 'home redirect failed; refusing to touch real Claude config');

const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron,
  filename: electron,
  loaded: true,
  exports: { app: { getPath: () => userData } }
};

const { ensureClaudePermissionsAccepted } = loadTs('src/main/config.ts');
const settingsPath = path.join(home, '.claude', 'settings.json');
const projectPath = path.join(home, '.claude.json');
const cwd = path.join(home, 'project');

test.beforeEach(() => {
  fs.rmSync(path.join(home, '.claude'), { recursive: true, force: true });
  fs.rmSync(projectPath, { recursive: true, force: true });
});

test.after(() => {
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  if (realProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realProfile;
  fs.rmSync(base, { recursive: true, force: true });
});

test('malformed settings are preserved while valid project trust still updates', () => {
  const original = '{\n  "env": {\n    "CUSTOM_VALUE": "preserve-me"\n  },\n';
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, original, 'utf8');
  fs.writeFileSync(projectPath, JSON.stringify({
    theme: 'dark',
    projects: { other: { hasTrustDialogAccepted: false, note: 'keep' } }
  }, null, 2), 'utf8');

  ensureClaudePermissionsAccepted(cwd);

  assert.equal(fs.readFileSync(settingsPath, 'utf8'), original);
  const project = JSON.parse(fs.readFileSync(projectPath, 'utf8'));
  assert.equal(project.theme, 'dark');
  assert.deepEqual(project.projects.other, { hasTrustDialogAccepted: false, note: 'keep' });
  assert.equal(project.projects[cwd].hasTrustDialogAccepted, true);
});

test('malformed project config is preserved while valid settings still update', () => {
  const original = '{\n  "projects": {\n';
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify({ env: { CUSTOM_VALUE: 'preserve-me' } }), 'utf8');
  fs.writeFileSync(projectPath, original, 'utf8');

  ensureClaudePermissionsAccepted(cwd);

  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.deepEqual(settings.env, { CUSTOM_VALUE: 'preserve-me' });
  assert.equal(settings.skipDangerousModePermissionPrompt, true);
  assert.equal(settings.skipAutoPermissionPrompt, true);
  assert.equal(fs.readFileSync(projectPath, 'utf8'), original);
});

test('valid configs preserve unrelated top-level and project fields', () => {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify({
    env: { CUSTOM_VALUE: 'preserve-me' },
    hooks: { example: true }
  }), 'utf8');
  fs.writeFileSync(projectPath, JSON.stringify({
    theme: 'dark',
    projects: { [cwd]: { note: 'keep-me' } }
  }), 'utf8');

  ensureClaudePermissionsAccepted(cwd);

  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), {
    env: { CUSTOM_VALUE: 'preserve-me' },
    hooks: { example: true },
    skipDangerousModePermissionPrompt: true,
    skipAutoPermissionPrompt: true
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(projectPath, 'utf8')), {
    theme: 'dark',
    projects: { [cwd]: { note: 'keep-me', hasTrustDialogAccepted: true } }
  });
});

test('missing configs are created with the required minimal fields', () => {
  ensureClaudePermissionsAccepted(cwd);

  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), {
    skipDangerousModePermissionPrompt: true,
    skipAutoPermissionPrompt: true
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(projectPath, 'utf8')), {
    projects: { [cwd]: { hasTrustDialogAccepted: true } }
  });
});

test('valid JSON with an unsafe root shape is preserved byte-for-byte', () => {
  // The formatted array includes a trailing newline so an implementation that
  // mutates array properties and reserializes it cannot pass by coincidence.
  for (const original of ['null', '[\n  1\n]\n', '"hello"']) {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, original, 'utf8');
    fs.writeFileSync(projectPath, original, 'utf8');

    ensureClaudePermissionsAccepted(cwd);

    assert.equal(fs.readFileSync(settingsPath, 'utf8'), original);
    assert.equal(fs.readFileSync(projectPath, 'utf8'), original);
  }
});

test('existing read failures are isolated per config path', () => {
  // A directory at the expected file path deterministically makes readFileSync
  // fail on supported platforms without relying on chmod semantics.
  fs.mkdirSync(settingsPath, { recursive: true });
  fs.writeFileSync(projectPath, JSON.stringify({ projects: {} }), 'utf8');

  ensureClaudePermissionsAccepted(cwd);

  assert.equal(fs.statSync(settingsPath).isDirectory(), true);
  assert.equal(
    JSON.parse(fs.readFileSync(projectPath, 'utf8')).projects[cwd].hasTrustDialogAccepted,
    true
  );

  fs.rmSync(path.join(home, '.claude'), { recursive: true, force: true });
  fs.rmSync(projectPath, { recursive: true, force: true });
  fs.mkdirSync(projectPath);
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify({ env: { KEEP: 'yes' } }), 'utf8');

  ensureClaudePermissionsAccepted(cwd);

  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.deepEqual(settings.env, { KEEP: 'yes' });
  assert.equal(settings.skipDangerousModePermissionPrompt, true);
  assert.equal(settings.skipAutoPermissionPrompt, true);
  assert.equal(fs.statSync(projectPath).isDirectory(), true);
});

test('repeated execution is idempotent once required fields are present', () => {
  ensureClaudePermissionsAccepted(cwd);
  const settingsAfterFirstRun = fs.readFileSync(settingsPath, 'utf8');
  const projectAfterFirstRun = fs.readFileSync(projectPath, 'utf8');

  ensureClaudePermissionsAccepted(cwd);

  assert.equal(fs.readFileSync(settingsPath, 'utf8'), settingsAfterFirstRun);
  assert.equal(fs.readFileSync(projectPath, 'utf8'), projectAfterFirstRun);
});
