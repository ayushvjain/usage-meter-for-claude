
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

// Optional local-network integration.
// Never transmit cookies, credentials, or account identifiers.
function readCYDConfig(userDataPath) {
  const filename = path.join(userDataPath, 'esp32-dashboard.json');

  let data;
  try {
    data = JSON.parse(fs.readFileSync(filename, 'utf8'));
  } catch {
    return null;
  }

  if (!data || data.enabled !== true) return null;

  const host = String(data.host || '').trim();
  const port = data.port === undefined ? 80 : Number(data.port);

  if (
    !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) ||
    host.split('.').some(x => Number(x) > 255) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    console.warn('[CYD] Invalid ESP32 address or port');
    return null;
  }

  // Only send to private IPv4 addresses.
  const octets = host.split('.').map(Number);

  const privateIP =
    octets[0] === 10 ||
    (octets[0] === 172 &&
      octets[1] >= 16 &&
      octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168);

  if (!privateIP) {
    console.warn('[CYD] Only private LAN IPv4 addresses are supported');
    return null;
  }

  return { host, port };
}

function sendUsageToCYD(limits, userDataPath) {
  const cfg = readCYDConfig(userDataPath);
  if (!cfg) return;

  const session = limits.find(
    limit => limit.kind === 'session' && !limit.scoped
  );

  if (!session) return;

  const percent = Number(session.percent);
  const resetEpoch = session.resetsAt
    ? Math.floor(Date.parse(session.resetsAt) / 1000)
    : 0;

  if (
    !Number.isFinite(percent) ||
    percent < 0 ||
    percent > 100 ||
    !Number.isSafeInteger(resetEpoch) ||
    resetEpoch < 0
  ) {
    return;
  }

  const payload = `${percent}|${resetEpoch}`;

  const request = http.request(
    {
      hostname: cfg.host,
      port: cfg.port,
      path: '/usage',
      method: 'POST',
      timeout: 3000,
      headers: {
        'Content-Type': 'text/plain',
        'Content-Length': Buffer.byteLength(payload)
      }
    },
    response => {
      response.resume();

      if (response.statusCode !== 200) {
        console.warn(`[CYD] HTTP ${response.statusCode}`);
      }
    }
  );

  request.on('timeout', () => {
    request.destroy(new Error('Timed out'));
  });

  request.on('error', err => {
    console.warn(`[CYD] ${err.message}`);
  });

  request.end(payload);
}

module.exports = {
  readCYDConfig,
  sendUsageToCYD
};
