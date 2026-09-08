// Local keystore (P-02): resolve the provider API key WITHOUT it ever
// entering protocol messages or config files.
//
// Resolution order:
//   1. macOS Keychain (`security find-generic-password`) when
//      AMCN_USE_KEYCHAIN=1 and a service name is given
//   2. process env var named by `env`
//
// Store a key in the Keychain (one-time, done by the Owner):
//   security add-generic-password -s amcn-provider-key -a $USER -w '<key>'
'use strict';
const { execFileSync } = require('node:child_process');

function getKey({ service, env } = {}) {
  if (process.platform === 'darwin' && service &&
      process.env.AMCN_USE_KEYCHAIN === '1') {
    try {
      return execFileSync('security',
        ['find-generic-password', '-s', service, '-w'],
        { encoding: 'utf8' }).trim();
    } catch { /* fall through to env */ }
  }
  if (env && process.env[env]) return process.env[env];
  return null;
}

module.exports = { getKey };
