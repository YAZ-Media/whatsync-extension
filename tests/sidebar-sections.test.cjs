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
  assert.match(hubspot, /case 'getSidebarSection'/);
});

test('sidebar appearance is a drag editor without the obsolete live preview', () => {
  const designer = read('website/src/pages/dashboard/SidebarDesigner.tsx');
  assert.match(designer, /draggable=\{canManage\}/);
  assert.match(designer, /reorderField\(sourceKey, targetKey\)/);
  assert.doesNotMatch(designer, /WhatsApp Sidebar Preview|DEMO_SAMPLE|previewMode|moveField/);
});
