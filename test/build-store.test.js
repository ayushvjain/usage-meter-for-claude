'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildArgs } = require('../scripts/build-store');

const IDENTITY = {
  identityName: 'Example.UsageMeterforClaude',
  publisher: 'CN=00000000-0000-0000-0000-000000000000',
  publisherDisplayName: 'Example Publisher',
};

test('store build: the identity is passed to electron-builder, never published to GitHub', () => {
  const args = buildArgs(IDENTITY);
  assert.deepEqual(args.slice(0, 5), ['electron-builder', '--win', 'appx', '--publish', 'never']);
  assert.ok(args.includes('-c.appx.identityName=Example.UsageMeterforClaude'));
  assert.ok(args.includes('-c.appx.publisher=CN=00000000-0000-0000-0000-000000000000'));
  assert.ok(args.includes('-c.appx.publisherDisplayName=Example Publisher'), 'spaces stay in one argument');
});

test('store build: refuses the example placeholders and incomplete files', () => {
  assert.throws(() => buildArgs(require('../store-identity.example.json')), /missing/);
  assert.throws(() => buildArgs({ ...IDENTITY, publisher: '' }), /publisher/);
  assert.throws(() => buildArgs({ ...IDENTITY, publisher: 'BDC86B6E' }), /CN=/);
  assert.throws(() => buildArgs(null), /missing/);
});
