const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

test('toolbar opens the docked WhatsApp experience without shipping the legacy popup', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const packageScript = read('package-extension.sh');
  assert.equal(manifest.version, manifest.version_name);
  assert.equal(manifest.action.default_popup, undefined);
  assert.equal(manifest.action.default_title, 'Open WhatSync in WhatsApp');
  assert.doesNotMatch(packageScript, /popup\.html|popup\.js|supabase\.js/);
  assert.match(read('background.js'), /openWhatSyncSidebar/);
  const content = read('content.js');
  assert.match(content, /id="ws-signin-btn"/);
  assert.match(content, /action: 'openPopup'/);
  assert.match(read('background.js'), /whatsync\.io\/auth\?mode=signin&source=extension/);
  assert.doesNotMatch(content, /type="password"/);
});

test('all conditional writes verify the deployed HubSpot write runtime', () => {
  const background = read('background.js');
  const content = read('content.js');
  const hubspot = read('supabase/functions/hubspot/index.ts');
  assert.match(content, /verifyHubSpotWriteRuntime/);
  assert.match(background, /assertHubSpotConditionalWriteRuntime/);
  assert.match(hubspot, /case 'getRuntimeInfo'/);
  assert.match(hubspot, /conditionalPropertyValidation: HUBSPOT_CRM_WRITE_VERSION === '2026-09'/);
});
