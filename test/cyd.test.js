
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readCYDConfig } = require('../src/main/cyd');

test('CYD integration is disabled without opt-in', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyd-'));

  try {
    assert.equal(readCYDConfig(dir), null);

    fs.writeFileSync(
      path.join(dir, 'esp32-dashboard.json'),
      JSON.stringify({
        enabled: false,
        host: '10.0.0.127'
      })
    );

    assert.equal(readCYDConfig(dir), null);

    fs.writeFileSync(
      path.join(dir, 'esp32-dashboard.json'),
      JSON.stringify({
        enabled: true,
        host: '10.0.0.127'
      })
    );

    assert.deepEqual(readCYDConfig(dir), {
      host: '10.0.0.127',
      port: 80
    });

    fs.writeFileSync(
      path.join(dir, 'esp32-dashboard.json'),
      JSON.stringify({
        enabled: true,
        host: '8.8.8.8'
      })
    );

    assert.equal(readCYDConfig(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
