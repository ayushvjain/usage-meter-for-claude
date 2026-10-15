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
  assert.deepStrictEqual(manifest.permissions, ['storage', 'alarms']);
  assert.deepStrictEqual(manifest.host_permissions, ['https://claude.ai/*']);
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
