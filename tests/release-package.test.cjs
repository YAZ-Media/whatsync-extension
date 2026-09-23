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

test('contact creation uses portal metadata and keeps required fields in the form', () => {
  const content = read('content.js');
  const background = read('background.js');
  const hubspot = read('supabase/functions/hubspot/index.ts');
  assert.match(content, /getCreatePropertyDefinitions/);
  assert.match(content, /class="hubspot-create-required-fields"/);
  assert.match(content, /requestValues: \(definitions\) => requestHubSpotCreateRequiredValues/);
  assert.match(background, /request\.action === 'getCreatePropertyDefinitions'/);
  assert.match(hubspot, /case 'getCreatePropertyDefinitions'/);
  assert.match(hubspot, /properties: sanitizeProperties/);
  assert.doesNotMatch(content, /<label for="lastName">Last Name \*<\/label>/);
  assert.match(content, /<input type="email" id="email"[^>]*required>/);
});

test('contact creation associates a HubSpot company instead of writing Company Name text', () => {
  const content = read('content.js');
  const background = read('background.js');
  const hubspot = read('supabase/functions/hubspot/index.ts');
  assert.doesNotMatch(content, /id="company" name="company"/);
  assert.doesNotMatch(content, /company:\s*form\.querySelector\('#company'\)/);
  assert.match(content, /id="companySearch"/);
  assert.match(content, /\+ Add a company/);
  assert.match(content, /companyId: companyAssociation\.companyId/);
  assert.match(background, /request\.action === 'searchHubSpotCompanies'/);
  assert.match(background, /request\.action === 'createHubSpotCompany'/);
  assert.match(hubspot, /case 'searchCompanies'/);
  assert.match(hubspot, /contactCompanyAssociationTypes/);
  assert.match(hubspot, /payload\.associations/);
});

test('contact creation stays concise without explanatory property copy', () => {
  const content = read('content.js');
  assert.doesNotMatch(content, /create-contact-account-note/);
  assert.doesNotMatch(content, /ws-property-description/);
  assert.doesNotMatch(content, /id="contactOwnerHint"/);
  assert.doesNotMatch(content, /id="companyPickerStatus"/);
  assert.match(content, /<label for="companySearch">Company<\/label>/);
});
