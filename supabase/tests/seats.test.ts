import { assertSeatCapacity, consumesPaidSeat } from '../functions/_shared/seats.ts';

const equal = (actual: unknown, expected: unknown) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
};

Deno.test('only active syncing roles consume paid seats', () => {
  equal(consumesPaidSeat('Owner', 'Active'), true);
  equal(consumesPaidSeat('Admin', 'Active'), true);
  equal(consumesPaidSeat('Member', 'Active'), true);
  equal(consumesPaidSeat('Billing', 'Active'), false);
  equal(consumesPaidSeat('Read-only', 'Active'), false);
  equal(consumesPaidSeat('Member', 'Suspended'), false);
});

Deno.test('seat capacity follows live Stripe quantity and rejects a full workspace', async () => {
  const savedFetch = globalThis.fetch;
  const priorOperator = Deno.env.get('BILLING_ADMIN_USER_IDS');
  Deno.env.set('EXTERNAL_SUPABASE_URL', 'https://test-project.supabase.co');
  Deno.env.set('EXTERNAL_SUPABASE_SERVICE_ROLE_KEY', 'fixture-service-key');
  Deno.env.set('BILLING_REQUIRE_LIVE', 'true');
  Deno.env.set('BILLING_ADMIN_USER_IDS', 'operator-id');
  let occupied = 1;

  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/billing_subscriptions')) {
      return Response.json([
        { status: 'active', current_period_end: '2035-01-01', livemode: true, quantity: 2 },
      ]);
    }
    if (url.includes('/user_profiles')) {
      return new Response(null, {
        status: 200,
        headers: { 'content-range': `0-${Math.max(0, occupied - 1)}/${occupied}` },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    await assertSeatCapacity('org-1', 'owner-id');
    occupied = 2;
    let message = '';
    try {
      await assertSeatCapacity('org-1', 'owner-id');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    equal(message.includes('2-seat plan is full'), true);
    await assertSeatCapacity('org-1', 'operator-id');
  } finally {
    globalThis.fetch = savedFetch;
    priorOperator === undefined
      ? Deno.env.delete('BILLING_ADMIN_USER_IDS')
      : Deno.env.set('BILLING_ADMIN_USER_IDS', priorOperator);
  }
});
