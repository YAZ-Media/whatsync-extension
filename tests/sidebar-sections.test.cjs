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
  assert.match(background, /request\.action === 'getSidebarSections'/);
  assert.match(background, /SIDEBAR_SECTION_UNAVAILABLE/);
  assert.match(hubspot, /case 'getSidebarSection'/);
  assert.match(hubspot, /case 'getSidebarSections'/);
  assert.match(hubspot, /getAllAssociationIds\(token, 'contacts', contactId, 'leads'\)/);
  assert.doesNotMatch(hubspot, /association\.id !== contactId/);
  assert.match(hubspot, /Connect HubSpot Leads to use this section/);
  assert.doesNotMatch(hubspot, /getContactStageHistory/);
  assert.match(content, /preloadRelatedSidebarSections/);
  assert.match(content, /const relatedSectionsPromise = preloadRelatedSidebarSections\(contactRecordId\(contacts\[0\]\)\)/);
  assert.match(content, /setupRelatedSidebarSections\(relatedSectionsPromise\)/);
  assert.doesNotMatch(content, /showRelatedSectionLoading/);
  assert.match(content, /ws-related-count">—/);
  assert.match(content, /Available after your workspace admin updates the HubSpot connection/);
  assert.match(content, /https:\/\/whatsync\.io\/dashboard\/integrations/);
  assert.doesNotMatch(content, /section\.hidden = true/);
  assert.doesNotMatch(content, /data-update-hubspot-access/);
  assert.doesNotMatch(background, /request\.action === 'updateHubSpotLeadAccess'/);
  assert.match(content, /key === 'lead_tracker' \? ''/);
  assert.match(content, /\+ Add in HubSpot/);
  const oauth = read('supabase/functions/hubspot-oauth/index.ts');
  assert.match(oauth, /optional_scope', 'sales-email-read crm\.objects\.leads\.read'/);
  assert.match(oauth, /requiresConnectionUpdate/);
  assert.match(oauth, /capabilities: \{ leadStageTracker \}/);
  assert.match(oauth, /introspectHubSpotToken\(tokens\.access_token\)/);
  assert.match(oauth, /Repair connections created by older callbacks/);
  const popup = read('popup.js');
  assert.match(popup, /Update connection/);
});

test('connection refresh clears every cache and updates open sidebars', () => {
  const content = read('content.js');
  const background = read('background.js');
  const bridge = read('dashboard-bridge.js');

  assert.match(content, /whatsyncStateCache = null;[\s\S]*refreshHubSpotIntegration/);
  assert.match(content, /changes\.hubspotConnectionRevision/);
  assert.match(background, /request\.action === 'refreshHubSpotIntegration'/);
  assert.match(background, /hubspotConnectionRevision: Date\.now\(\)/);
  assert.match(bridge, /whatsync\.hubspotConnectionUpdated/);
  assert.match(bridge, /action: 'refreshHubSpotIntegration'/);
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
  assert.match(content, /Refresh WhatsApp Web to load this section with the latest WhatSync connection/);
  assert.doesNotMatch(content, /escapeHtml\(error\?\.message/);
  assert.match(css, /\.activities-section,\s*#hubspot-sidebar \.ws-related-section/);
  assert.match(css, /\.ws-related-retry/);
  assert.match(content, /ws-related-reconnect/);
  assert.match(css, /--ws-section-header-height:\s*50px/);
  assert.match(css, /--ws-section-x:\s*14px/);
  assert.match(css, /#hubspot-sidebar \.info-row \{\s*min-height: 0;\s*padding: 8px 0;/);
  assert.match(css, /\.ws-related-loading \{ display: none !important; \}/);
});

test('sidebar appearance has drag ordering and a functional fictional-data preview', { skip: !fs.existsSync(path.join(root, 'website/src/pages/dashboard/SidebarDesigner.tsx')) }, () => {
  const designer = read('website/src/pages/dashboard/SidebarDesigner.tsx');
  assert.match(designer, /draggable=\{canManage\}/);
  assert.match(designer, /reorderField\(sourceKey, targetKey\)/);
  assert.match(designer, /lg:grid-cols-\[minmax\(0,1fr\)_minmax\(360px,420px\)\]/);
  assert.match(designer, /lg:sticky lg:top-6/);
  assert.match(designer, /Aisha Rahman/);
  assert.doesNotMatch(designer, /fetchEdgeFunction|DEMO_SAMPLE|moveField|previewMode|Preview sidebar/);
});
