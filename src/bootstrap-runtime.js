// Runtime bootstrap for deployment configuration that must exist before src/server.js loads.
// Keep production origin configuration environment-driven; this only migrates the
// old Nexipa Render frontend value to the current public frontend when a stale
// Render variable is still present.
'use strict';

function clean(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

const configuredFrontend = clean(process.env.FRONTEND_URL);
const currentFrontend = configuredFrontend && !/nexipa\.onrender\.com/i.test(configuredFrontend)
  ? configuredFrontend
  : 'https://necpra.co.ke';

process.env.FRONTEND_URL = currentFrontend;

const existing = clean(process.env.CORS_ADDITIONAL_ORIGINS)
  .split(',')
  .map(clean)
  .filter(Boolean);

if (!existing.includes(currentFrontend)) existing.push(currentFrontend);
process.env.CORS_ADDITIONAL_ORIGINS = existing.join(',');

if (process.env.DEBUG_SERVER === '1') {
  console.log(`[Runtime] CORS frontend origin: ${currentFrontend}`);
}
