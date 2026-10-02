'use strict';
// Regression: ephemeralRetentionService.js shipped with escaped backticks and
// failed to parse at startup ("Invalid or unexpected token").
const { execFileSync } = require('child_process');
const path = require('path');
const files = [
  'src/services/ephemeralRetentionService.js',
  'src/services/messageBroadcast.js',
  'src/services/messageDeliveryService.js',
  'src/routes/messages.js',
  'src/models/GameChallenge.js',
];
test.each(files)('%s parses', (f) => {
  expect(() => execFileSync(process.execPath, ['--check', path.resolve(__dirname, '../..', f)])).not.toThrow();
});
