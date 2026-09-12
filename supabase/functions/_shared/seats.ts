import { createClient } from 'npm:@supabase/supabase-js@2';
import { hasPaidAccess } from './billing-policy.ts';
import { isOperator } from './operator.ts';

const BILLABLE_ROLES = new Set(['Owner', 'Admin', 'Member']);

export function consumesPaidSeat(role: unknown, status: unknown): boolean {
  return String(status || 'Active') === 'Active' && BILLABLE_ROLES.has(String(role || 'Member'));
}

/**
 * Ensure a workspace has room for additional active syncing users.
 * Stripe subscription quantity is the source of truth. Billing and Read-only
 * users remain free because they cannot sync CRM data.
 */
export async function assertSeatCapacity(
  organizationId: string,
  actorUserId: string,
  additionalSeats = 1,
): Promise<void> {
  if (additionalSeats <= 0 || isOperator(actorUserId)) return;

  const externalUrl = Deno.env.get('EXTERNAL_SUPABASE_URL');
  const serviceKey = Deno.env.get('EXTERNAL_SUPABASE_SERVICE_ROLE_KEY');
  if (!externalUrl || !serviceKey) {
    throw new Error('Billing access is temporarily unavailable. Please retry.');
  }

  const db = createClient(externalUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const liveOnly = Deno.env.get('BILLING_REQUIRE_LIVE') === 'true';

  const [{ data: subscriptions, error: subscriptionError }, { count, error: memberError }] =
    await Promise.all([
      db
        .from('billing_subscriptions')
        .select('status,current_period_end,livemode,quantity')
        .eq('account_id', organizationId)
        .order('updated_at', { ascending: false }),
      db
        .from('user_profiles')
        .select('user_id', { count: 'exact', head: true })
        .eq('organization_id', organizationId)
        .eq('status', 'Active')
        .in('role', ['Owner', 'Admin', 'Member']),
    ]);

  if (subscriptionError || memberError) {
    throw new Error('We couldn’t verify your available seats. Please retry.');
  }

  const subscription = subscriptions?.find((item) =>
    (!liveOnly || item.livemode === true) &&
    hasPaidAccess(item.status, item.current_period_end)
  );
  if (!subscription) {
    throw new Error('Add a plan in Billing before inviting or activating syncing users.');
  }

  const purchasedSeats = Math.max(1, Number(subscription.quantity) || 1);
  const occupiedSeats = Math.max(0, Number(count) || 0);
  if (occupiedSeats + additionalSeats > purchasedSeats) {
    throw new Error(
      `Your ${purchasedSeats}-seat plan is full. Add a seat in Billing before inviting or activating another syncing user.`,
    );
  }
}
