const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('all configurable relationship sections have a real extension and API path', () => {
  const content = read('content.js');
  const background = read('background.js');
  const hubspot = read('supabase/functions/hubspot/index.ts');
  const keys = ['companies', 'contacts', 'lead_tracker', 'attachments'];

  for (const key of keys) {
    assert.match(content, new RegExp(`relatedSidebarSectionMarkup\\('${key}'`));
    assert.match(hubspot, new RegExp(`case '${key}'`));
  }
  assert.match(background, /request\.action === 'getSidebarSection'/);
  assert.match(background, /SIDEBAR_SECTION_UNAVAILABLE/);
  assert.match(hubspot, /case 'getSidebarSection'/);
});

test('HubSpot conditional rules use enforced writes and remain configurable', () => {
  const content = read('content.js');
  const hubspot = read('supabase/functions/hubspot/index.ts');
  assert.match(hubspot, /HUBSPOT_CRM_WRITE_VERSION = '2026-09'/);
  assert.match(content, /runHubSpotConditionalWrite/);
  assert.match(content, /conditional_properties/);
  assert.match(content, /rememberConditionalContactFields/);
});

test('related sections share the CRM hierarchy and hide technical backend errors', () => {
  const content = read('content.js');
  const css = read('content.css');
  assert.match(content, /This section needs the latest WhatSync connection/);
  assert.doesNotMatch(content, /escapeHtml\(error\?\.message/);
  assert.match(css, /\.activities-section,\s*#hubspot-sidebar \.ws-related-section/);
  assert.match(css, /\.ws-related-retry/);
});

test('sidebar appearance has drag ordering and a functional fictional-data preview', () => {
  const designer = read('website/src/pages/dashboard/SidebarDesigner.tsx');
  assert.match(designer, /draggable=\{canManage\}/);
  assert.match(designer, /reorderField\(sourceKey, targetKey\)/);
  assert.match(designer, /lg:grid-cols-\[minmax\(0,1fr\)_minmax\(360px,420px\)\]/);
  assert.match(designer, /lg:sticky lg:top-6/);
  assert.match(designer, /Aisha Rahman/);
  assert.doesNotMatch(designer, /fetchEdgeFunction|DEMO_SAMPLE|moveField|previewMode|Preview sidebar/);
});
