'use strict';

/*
 * Builds the Microsoft Store package (.appx).
 *
 * The Store identity (from Partner Center > Product management > Product identity) is read
 * from store-identity.json, a local file that is not committed, so account details stay out
 * of the public repo. Copy store-identity.example.json to store-identity.json and fill it in.
 *
 *   npm run dist:store
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const IDENTITY_FILE = path.join(ROOT, 'store-identity.json');
const FIELDS = ['identityName', 'publisher', 'publisherDisplayName'];

/** Checks the identity and turns it into electron-builder command-line arguments. */
function buildArgs(identity) {
  const missing = FIELDS.filter((key) => {
    const value = identity && identity[key];
    return typeof value !== 'string' || !value.trim() || value.includes('REPLACE');
  });
  if (missing.length) throw new Error(`store-identity.json is missing: ${missing.join(', ')}`);
  if (!identity.publisher.startsWith('CN=')) throw new Error('store-identity.json: "publisher" must start with CN=');

  const args = ['electron-builder', '--win', 'appx', '--publish', 'never'];
  for (const key of FIELDS) args.push(`-c.appx.${key}=${identity[key].trim()}`);
  return args;
}

function readIdentity() {
  if (!fs.existsSync(IDENTITY_FILE)) {
    throw new Error(
      'store-identity.json not found. Copy store-identity.example.json to store-identity.json ' +
        'and fill in the values from Partner Center > Product management > Product identity.',
    );
  }
  return JSON.parse(fs.readFileSync(IDENTITY_FILE, 'utf8'));
}

if (require.main === module) {
  try {
    const [, ...args] = buildArgs(readIdentity());
    // Run electron-builder's CLI with Node directly (no shell), so a publisher name with
    // spaces stays a single argument.
    const cli = path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js');
    const result = spawnSync(process.execPath, [cli, ...args], { cwd: ROOT, stdio: 'inherit' });
    process.exit(result.status === null ? 1 : result.status);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { buildArgs };
