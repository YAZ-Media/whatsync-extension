import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  buildHubSpotValidationDetails,
  extractHubSpotRequiredProperties,
} from '../functions/_shared/hubspotValidation.ts';

Deno.test('extracts conditional required property names from HubSpot validation messages', () => {
  const payload = {
    category: 'VALIDATION_ERROR',
    correlationId: 'fixture-correlation',
    message: `Property 'lead_tier' is required when 'hs_lead_status' is set to 'QUALIFIED'.`,
  };
  assertEquals(extractHubSpotRequiredProperties(payload), ['lead_tier']);
});

Deno.test('extracts structured required fields and rejects unsafe property names', () => {
  const payload = {
    errors: [
      { category: 'REQUIRED_PROPERTY', propertyName: 'disqualification_reason', message: 'A required field is missing.' },
      { category: 'REQUIRED_PROPERTY', propertyName: '../token', message: 'A required field is missing.' },
    ],
  };
  assertEquals(extractHubSpotRequiredProperties(payload), ['disqualification_reason']);
});

Deno.test('parses the current HubSpot conditional and create-form error shapes', () => {
  assertEquals(extractHubSpotRequiredProperties({ errors: [{
    code: 'MISSING_CONDITIONAL_REQUIRED_PROPERTY',
    message: 'lead_tier is required because of a conditional property rule based on [hs_lead_status]',
    context: { propertyName: ['lead_tier'] },
  }] }), ['lead_tier']);
  assertEquals(extractHubSpotRequiredProperties({ errors: [{
    code: 'MISSING_REQUIRED_PROPERTY',
    message: 'A value for custom_contact_type must be provided',
    context: { propertyName: ['custom_contact_type'] },
  }] }), ['custom_contact_type']);
  assertEquals(extractHubSpotRequiredProperties({
    response: {
      validation: {
        missingRequiredProperties: ['disqualification_reason'],
      },
    },
  }), ['disqualification_reason']);
});

Deno.test('builds safe validation metadata for the current object write path', () => {
  const details = buildHubSpotValidationDetails({
    category: 'VALIDATION_ERROR',
    correlationId: 'fixture-correlation',
    message: `Property "lead_tier" is required when "hs_lead_status" is set to "QUALIFIED".`,
    accessToken: 'must-not-leak',
  }, '/crm/objects/2026-09/contacts/123');
  assertEquals(details, {
    provider: 'hubspot',
    validation: true,
    objectType: 'contacts',
    category: 'VALIDATION_ERROR',
    correlationId: 'fixture-correlation',
    requiredProperties: ['lead_tier'],
  });
});
