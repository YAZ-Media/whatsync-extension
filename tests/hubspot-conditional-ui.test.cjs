const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { parse } = require('../website/node_modules/acorn');

const source = fs.readFileSync(require.resolve('../content.js'), 'utf8');
const ast = parse(source, { ecmaVersion: 'latest' });
const functions = (names) => ast.body
  .filter((node) => node.type === 'FunctionDeclaration' && names.includes(node.id.name))
  .map((node) => source.slice(node.start, node.end))
  .join('\n');

test('sidebar recognizes HubSpot conditional required property errors', () => {
  const ctx = vm.createContext({});
  vm.runInContext(functions(['requiredHubSpotProperties']), ctx);
  const result = ctx.requiredHubSpotProperties({
    message: `Property 'lead_tier' is required when 'hs_lead_status' is set to 'QUALIFIED'.`,
    details: { requiredProperties: ['lead_tier', 'custom_reason'] },
  });
  assert.deepEqual([...result], ['lead_tier', 'custom_reason']);
});

test('sidebar recognizes nested HubSpot conditional validation payloads', () => {
  const ctx = vm.createContext({});
  vm.runInContext(functions(['requiredHubSpotProperties']), ctx);
  const result = ctx.requiredHubSpotProperties({
    details: {
      response: {
        errors: [{
          code: 'MISSING_CONDITIONAL_REQUIRED_PROPERTY',
          context: { missingRequiredProperties: ['disqualification_reason'] },
          message: 'A value for lead_tier must be provided',
        }],
      },
    },
  });
  assert.deepEqual([...result], ['disqualification_reason', 'lead_tier']);
});

test('sidebar recognizes 2026-09 validation context variants', () => {
  const ctx = vm.createContext({});
  vm.runInContext(functions(['requiredHubSpotProperties']), ctx);
  const result = ctx.requiredHubSpotProperties({
    category: 'PROPERTY_VALIDATION_ERROR',
    errors: [{
      code: 'MISSING_CONDITIONAL_REQUIRED_PROPERTIES',
      message: 'Missing required property: lead_tier',
      context: {
        propertyNames: ['lead_tier'],
        missingRequiredProperties: ['qualification_reason'],
      },
    }],
  });
  assert.deepEqual([...result], ['lead_tier', 'qualification_reason']);
});

test('sidebar learns the controlling value from HubSpot conditional validation', () => {
  const ctx = vm.createContext({});
  vm.runInContext(functions(['hubSpotConditionalRuleContexts']), ctx);
  const result = ctx.hubSpotConditionalRuleContexts({
    message: `Property 'lead_tier' is required when 'hs_lead_status' is set to 'QUALIFIED'.`,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), [{
    dependentProperty: 'lead_tier',
    controllingProperty: 'hs_lead_status',
    controllingValue: 'QUALIFIED',
  }]);
});

test('conditional write retries atomically with the required values', async () => {
  let attempts = 0;
  let requestedDefinitions = [];
  const ctx = vm.createContext({
    requiredHubSpotProperties: (error) => error.details?.requiredProperties || [],
    hubSpotConditionalRuleContexts: () => [{
      dependentProperty: 'lead_tier',
      controllingProperty: 'hs_lead_status',
      controllingValue: 'QUALIFIED',
    }],
    fetchHubSpotPropertyDefinitions: async (_, names) => {
      requestedDefinitions = names;
      return names.map((name) => ({ name }));
    },
    rememberHubSpotConditionalDefinitions: async (_, definitions) => {
      assert.equal(definitions[0].controllingProperty, 'hs_lead_status');
      assert.equal(definitions[0].controllingValue, 'QUALIFIED');
    },
    requestHubSpotRequiredValues: async () => ({ lead_tier: 'tier_1' }),
    hubSpotResponseError: (response) => Object.assign(new Error(response.error), { details: response.details }),
  });
  vm.runInContext(functions(['runHubSpotConditionalWrite']), ctx);
  const response = await ctx.runHubSpotConditionalWrite({
    objectType: 'contacts',
    properties: { hs_lead_status: 'QUALIFIED' },
    write: async (properties) => {
      attempts += 1;
      if (attempts === 1) return { success: false, error: 'Required', details: { requiredProperties: ['lead_tier', 'hs_lead_status'] } };
      return { success: true, data: { properties } };
    },
  });
  assert.equal(attempts, 2);
  assert.deepEqual(requestedDefinitions, ['lead_tier']);
  assert.equal(response.data.properties.hs_lead_status, 'QUALIFIED');
  assert.equal(response.data.properties.lead_tier, 'tier_1');
  assert.equal(response.whatsyncSubmittedProperties.hs_lead_status, 'QUALIFIED');
  assert.equal(response.whatsyncConditionalFields.length, 1);
  assert.equal(response.whatsyncConditionalFields[0].name, 'lead_tier');
  assert.equal(response.whatsyncConditionalFields[0].value, 'tier_1');
  assert.equal(response.whatsyncConditionalFields[0].controllingProperty, 'hs_lead_status');
});
