'use strict';

/*
 * Checks on the Chrome extension that don't need a browser: the shared logic really is
 * shared (byte for byte with src/shared/core.js), the manifest agrees with package.json,
 * and every file the manifest and the pages point at is actually there.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const extension = path.join(root, 'extension');
const manifest = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('the extension ships the same shared core as the desktop app', () => {
  const desktop = fs.readFileSync(path.join(root, 'src', 'shared', 'core.js'), 'utf8');
  const copy = fs.readFileSync(path.join(extension, 'shared', 'core.js'), 'utf8');
  assert.strictEqual(copy, desktop, 'extension/shared/core.js is out of date; run `npm run sync:extension`');
});

test('the manifest version matches package.json', () => {
  assert.strictEqual(manifest.version, pkg.version);
});

test('the manifest only asks for the permissions it uses', () => {
  assert.deepStrictEqual(manifest.permissions, ['storage', 'alarms', 'scripting']);
  assert.deepStrictEqual(manifest.host_permissions, ['https://claude.ai/*']);
});

test('both toolbar icon sets are complete', () => {
  // The manifest's set is the one the stores show; the Classic set is swapped in at runtime
  // when someone picks that style, so a missing size would leave a blank toolbar button.
  for (const size of [16, 32, 48, 128]) {
    assert.ok(fs.existsSync(path.join(extension, 'icons', `icon-${size}.png`)), `missing icon-${size}.png`);
    assert.ok(fs.existsSync(path.join(extension, 'icons', `icon-classic-${size}.png`)), `missing icon-classic-${size}.png`);
  }
});

test('the page reader ships with the extension', () => {
  for (const file of ['claude-page.js', 'claude-bridge.js']) {
    assert.ok(fs.existsSync(path.join(extension, file)), `missing ${file}`);
  }
  // Registered at runtime, only while the setting is on, so the manifest must not run it.
  assert.ok(!manifest.content_scripts, 'the reader must not be a static content script');
});

test('every file the manifest points at exists', () => {
  const files = [
    manifest.action.default_popup,
    manifest.background.service_worker,
    manifest.options_ui.page,
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
  ];
  for (const file of files) {
    assert.ok(fs.existsSync(path.join(extension, file)), `missing ${file}`);
  }
});

test('every file the pages load exists', () => {
  for (const page of ['popup.html', 'options.html']) {
    const html = fs.readFileSync(path.join(extension, page), 'utf8');
    const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]).filter((u) => !/^https?:/.test(u));
    for (const ref of refs) {
      assert.ok(fs.existsSync(path.join(extension, ref)), `${page} points at missing ${ref}`);
    }
  }
});
