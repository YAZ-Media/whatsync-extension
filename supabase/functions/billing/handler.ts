import { operatorAction } from './operator.ts';
import { isOperator } from '../_shared/operator.ts';
import Stripe from 'npm:stripe@18.5.0';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { authenticateRequest } from '../_shared/auth.ts';
import { PLAN_KEYS, isPlan, canManageBilling, planPriceEnvKey, type PlanKey } from '../_shared/billing-policy.ts';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info, stripe-signature' };
const json = (body: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const env = (key: string) => Deno.env.get(key) || '';
const priceId = (plan: PlanKey) => env(planPriceEnvKey(plan));
const salesEnabled = () => env('BILLING_SALES_ENABLED') === 'true';
const acceptanceCheckoutEnabled = (email: string | null | undefined) => {
  const allowed = env('BILLING_ACCEPTANCE_EMAILS').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  return !!email && allowed.includes(email.trim().toLowerCase());
};
const stripeClient = () => {
  if (!env('STRIPE_SECRET_KEY')) throw new Error('Billing provider is not configured.');
  return new Stripe(env('STRIPE_SECRET_KEY'), { httpClient: Stripe.createFetchHttpClient(), maxNetworkRetries: 2 });
};
const database = () => {
  if (!env('EXTERNAL_SUPABASE_URL') || !env('EXTERNAL_SUPABASE_SERVICE_ROLE_KEY')) throw new Error('Billing database is not configured.');
  return createClient(env('EXTERNAL_SUPABASE_URL'), env('EXTERNAL_SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false, autoRefreshToken: false } });
};
const origin = () => {
  const url = new URL(env('APP_URL') || 'https://whatsync.io');
  if (url.protocol !== 'https:' && !['localhost','127.0.0.1'].includes(url.hostname)) throw new Error('Invalid application URL.');
  return url.origin;
};
async function planCatalog() {
  const stripe = stripeClient();
  const plans = await Promise.all(PLAN_KEYS.map(async name => {
    if (!priceId(name)) throw new Error('A subscription price is not configured.');
    const price = await stripe.prices.retrieve(priceId(name));
    if (!price.active || !price.recurring || price.unit_amount === null) throw new Error('Invalid subscription price configuration.');
    return { name, amount: price.unit_amount, currency: price.currency, interval: price.recurring.interval, intervalCount: price.recurring.interval_count };
  }));
  return { salesEnabled: true, plans };
}
function must<T extends { error: unknown }>(result: T): T {
  if (result.error) throw new Error('Billing data is temporarily unavailable. Please retry.');
  return result;
}

export async function handleBilling(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return json(null, 204);
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  // Stripe webhooks use a signature, never a client-supplied userId or JWT bypass.
  if (req.headers.has('stripe-signature')) {
    if (!env('STRIPE_WEBHOOK_SECRET') || !env('STRIPE_SECRET_KEY')) return json({ error: 'Webhook not configured' }, 503);
    const stripe = stripeClient();
    let event: Stripe.Event;
    try {
      event = await stripe.webhooks.constructEventAsync(await req.text(), req.headers.get('stripe-signature')!, env('STRIPE_WEBHOOK_SECRET'), undefined, Stripe.createSubtleCryptoProvider());
    } catch { return json({ error: 'Invalid webhook signature' }, 400); }
    try {
      const supported = ['customer.subscription.created','customer.subscription.updated','customer.subscription.deleted','invoice.paid','invoice.payment_failed','checkout.session.completed'];
      if (!supported.includes(event.type)) return json({ received: true });
      const ext = database();
      const object = event.data.object as unknown as Record<string, unknown>;
      const customerId = typeof object.customer === 'string' ? object.customer : null;
      if (!customerId) return json({ received: true });
      const account = must(await ext.from('billing_customers').select('account_id').eq('stripe_customer_id', customerId).maybeSingle()).data;
      // Ignore another product's customers; metadata alone cannot grant access.
      if (!account) return json({ received: true });
      const parent = object.parent as { subscription_details?: { subscription?: string } } | undefined;
      const subscriptionId = event.type.startsWith('customer.subscription.') ? String(object.id) : (object.subscription || parent?.subscription_details?.subscription) as string | undefined;
      if (!subscriptionId) return json({ received: true });
      // Fetch current provider state, rather than trusting potentially old event snapshots.
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      if (subscription.customer !== customerId) return json({ error: 'Customer mismatch' }, 400);
      const item = subscription.items.data[0];
      const plan = PLAN_KEYS.find(plan => priceId(plan) === item?.price.id);
      if (!plan || subscription.items.data.length !== 1) throw new Error('Unrecognized subscription price');
      const periodEnd = item?.current_period_end;
      const snapshot = {
        stripe_subscription_id: subscription.id, account_id: account.account_id, plan_name: plan,
        status: subscription.status, currency: item.price.currency, unit_amount: item.price.unit_amount,
        quantity: item.quantity || 1, billing_interval: item.price.recurring?.interval || null,
        current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
        cancel_at_period_end: subscription.cancel_at_period_end, livemode: subscription.livemode,
      };
      // Transactional replay protection and event ordering. Failed writes return 500 for Stripe retry.
      must(await ext.rpc('apply_billing_event', { p_event_id: event.id, p_created: event.created, p_snapshot: snapshot }));
      return json({ received: true });
    } catch (error) {
      console.error('Billing webhook could not be applied:', error instanceof Error ? error.message : 'unknown');
      return json({ error: 'Webhook processing failed; please retry' }, 500);
    }
  }
  try {
    const { action, data = {} } = await req.json();
    if (action === 'getPlans') {
      if (!salesEnabled()) return json({ salesEnabled: false, plans: [] });
      return json(await planCatalog());
    }
    const auth = await authenticateRequest(req, data.userId || null);
    if (!auth.ok) return json({ error: auth.error }, auth.status);
    const ext = database();
    const profile = must(await ext.from('user_profiles').select('role,status,organization_id,email').eq('user_id', auth.userId).maybeSingle()).data;
    if (!profile || profile.status !== 'Active') return json({ error: 'An active workspace account is required.' }, 403);
    const accountId = profile.organization_id || auth.userId;
    const operator = isOperator(auth.userId);
    const checkoutEnabled = salesEnabled() || acceptanceCheckoutEnabled(profile.email);
    if (action === 'getAdminAccess') return json({ isOperator: operator });
    if (['getOperatorOverview','listOperatorAccounts','getBillingHealth'].includes(action)) {
      if (!operator) return json({error:'Operator access required.'},403);
      return json(await operatorAction(action,data,auth.userId,ext));
    }
    if (action === 'listSubscribers') {
      if (!operator) return json({ error: 'Operator access required.' }, 403);
      const page = Math.max(0, Math.min(Number(data.page) || 0, 10000));
      const filter = ['active','trialing','past_due','canceled','unpaid','incomplete','incomplete_expired','paused'].includes(data.status) ? data.status : null;
      let query = ext.from('billing_subscriptions').select('account_id,plan_name,status,currency,unit_amount,quantity,billing_interval,current_period_end,cancel_at_period_end,updated_at,livemode,billing_customers(billing_email)', { count: 'exact' }).order('updated_at',{ascending:false}).order('account_id');
      if (filter) query = query.eq('status', filter);
      const rows = must(await query.range(page * 50, page * 50 + 49));
      return json({ subscribers: rows.data?.map(row => ({...row, billing_email: (row.billing_customers as unknown as {billing_email?:string})?.billing_email || null})), total: rows.count, page });
    }
    if (!['Owner','Admin','Billing','Read-only'].includes(profile.role)) return json({ error: 'Billing access required.' },403);
    const customer = must(await ext.from('billing_customers').select('stripe_customer_id').eq('account_id', accountId).maybeSingle()).data;
    if (action === 'getBillingData') {
      const subscription = must(await ext.from('billing_subscriptions').select('plan_name,status,currency,unit_amount,quantity,billing_interval,current_period_end,cancel_at_period_end,updated_at').eq('account_id',accountId).order('updated_at',{ascending:false}).limit(1).maybeSingle()).data;
      return json({ subscription, hasCustomer: !!customer, salesEnabled: checkoutEnabled, internalAccess: operator });
    }
    if (action === 'getWorkspacePlans') {
      return checkoutEnabled ? json(await planCatalog()) : json({ salesEnabled: false, plans: [] });
    }
    if (!canManageBilling(profile.role, profile.status)) return json({ error: 'Only a workspace owner or billing manager can manage this subscription.' },403);
    if (['savePaymentMethod','processPayment','changePlan','deletePaymentMethod','setDefaultPaymentMethod'].includes(action)) return json({ error: 'Use secure hosted checkout or the billing portal. Card details are not accepted here.' },410);
    const stripe = stripeClient();
    if (action === 'createPortalSession') {
      if (!customer) return json({ error: 'No billing account yet. Choose a subscription first.' },409);
      const session = await stripe.billingPortal.sessions.create({ customer:customer.stripe_customer_id, ...(env('STRIPE_PORTAL_CONFIGURATION_ID') ? {configuration:env('STRIPE_PORTAL_CONFIGURATION_ID')} : {}),return_url:`${origin()}/dashboard/billing` });
      return json({ url:session.url });
    }
    if (action === 'updateSubscriptionSeats') {
      if (!customer) return json({ error: 'No billing account yet. Choose a subscription first.' }, 409);
      const requestedSeats = Number(data.seats);
      const seats = Number.isInteger(requestedSeats) ? requestedSeats : 0;
      if (seats < 1 || seats > 250) return json({ error: 'Choose between 1 and 250 syncing users.' }, 400);

      const billable = must(await ext.from('user_profiles').select('user_id', { count: 'exact', head: true })
        .eq('organization_id', accountId).eq('status', 'Active').in('role', ['Owner', 'Admin', 'Member']));
      const minimumSeats = Math.max(1, billable.count || 0);
      if (seats < minimumSeats) {
        return json({ error: `This workspace currently needs at least ${minimumSeats} syncing seats.` }, 400);
      }

      const stored = must(await ext.from('billing_subscriptions')
        .select('stripe_subscription_id,status,quantity,livemode')
        .eq('account_id', accountId).in('status', ['active', 'trialing'])
        .order('updated_at', { ascending: false }).limit(1).maybeSingle()).data;
      if (!stored?.stripe_subscription_id) return json({ error: 'An active subscription is required to change seats.' }, 409);
      if (env('BILLING_REQUIRE_LIVE') === 'true' && stored.livemode !== true) {
        return json({ error: 'A live subscription is required to change seats.' }, 409);
      }

      const subscription = await stripe.subscriptions.retrieve(stored.stripe_subscription_id);
      if (subscription.customer !== customer.stripe_customer_id) return json({ error: 'Billing account mismatch.' }, 409);
      const item = subscription.items.data[0];
      if (!item || subscription.items.data.length !== 1 || !PLAN_KEYS.some(plan => priceId(plan) === item.price.id)) {
        return json({ error: 'This subscription cannot be changed automatically. Contact support.' }, 409);
      }
      if ((item.quantity || 1) === seats) return json({ quantity: seats, unchanged: true });

      const updated = await stripe.subscriptions.update(subscription.id, {
        items: [{ id: item.id, quantity: seats }],
        proration_behavior: 'always_invoice',
        payment_behavior: 'pending_if_incomplete',
      });
      const pendingQuantity = updated.pending_update?.subscription_items?.find(entry => entry.id === item.id)?.quantity;
      return json({
        quantity: pendingQuantity || updated.items.data[0]?.quantity || item.quantity || 1,
        pending: !!updated.pending_update,
      });
    }
    if (action === 'createCheckoutSession') {
      if (!checkoutEnabled) return json({ error:'Subscriptions are not open yet.' },503);
      if (!isPlan(data.planName) || !priceId(data.planName)) return json({ error:'Choose a configured subscription plan.' },400);
      if (data.termsAccepted !== true) return json({ error:'Accept the subscription terms before checkout.' },400);
      const requestedSeats = Number(data.seats);
      const seats = Number.isInteger(requestedSeats) ? requestedSeats : 1;
      if (seats < 1 || seats > 250) return json({ error:'Choose between 1 and 250 syncing users.' },400);
      const billable = must(await ext.from('user_profiles').select('user_id',{count:'exact',head:true}).eq('organization_id',accountId).eq('status','Active').in('role',['Owner','Admin','Member']));
      const minimumSeats = Math.max(1, billable.count || 0);
      if (seats < minimumSeats) return json({ error:`This workspace currently needs at least ${minimumSeats} syncing seats.` },400);
      let customerId = customer?.stripe_customer_id;
      if (!customerId) {
        const created = await stripe.customers.create({email:profile.email,metadata:{account_id:accountId}}, {idempotencyKey:`whatsync-customer-${accountId}`});
        customerId = created.id;
        must(await ext.from('billing_customers').upsert({account_id:accountId,stripe_customer_id:customerId,billing_email:profile.email},{onConflict:'account_id'}));
      }
      const subscriptions = await stripe.subscriptions.list({customer:customerId,status:'all',limit:100});
      if (subscriptions.data.some(s => !['canceled','incomplete_expired'].includes(s.status))) return json({error:'This workspace already has a subscription. Use Manage billing to change it.'},409);
      const attempt = must(await ext.rpc('reserve_billing_checkout', {p_account_id:accountId,p_plan_name:data.planName,p_seats:seats})).data;
      if (!attempt?.attempt_id || !attempt.expires_at) throw new Error('Unable to reserve checkout. Please retry.');
      if (attempt.plan_name !== data.planName || Number(attempt.seats) !== seats) return json({error:`A ${attempt.plan_name} checkout for ${attempt.seats} seat(s) is already reserved for this workspace. Resume it, or make a new choice after ${new Date(attempt.expires_at * 1000).toISOString()}.`},409);
      // Persisted ID and expiry are identical across tabs and time boundaries.
      // Stripe expires the old session before the database issues another ID.
      // If an initial provider call was never made and retry occurs with less
      // than Stripe's minimum 30-minute lifetime, it fails visibly until expiry.
      const session = await stripe.checkout.sessions.create({
        mode:'subscription',customer:customerId,client_reference_id:accountId,
        expires_at:attempt.expires_at,
        line_items:[{price:priceId(data.planName),quantity:seats,adjustable_quantity:{enabled:true,minimum:minimumSeats,maximum:250}}],
        success_url:`${origin()}/dashboard/billing?checkout=returned`,cancel_url:`${origin()}/dashboard/billing?checkout=canceled`,
        metadata:{account_id:accountId,terms_version:'2026-09-12',terms_accepted_by:auth.userId},
        subscription_data:{metadata:{account_id:accountId,terms_version:'2026-09-12',terms_accepted_by:auth.userId}},allow_promotion_codes:true,
      }, {idempotencyKey:`checkout-${attempt.attempt_id}`});
      return json({url:session.url});
    }
    return json({error:'Unknown billing action'},400);
  } catch (error) {
    console.error('Billing request failed:', error instanceof Error ? error.message : 'unknown');
    return json({error:error instanceof Error ? error.message : 'Billing is temporarily unavailable.'},500);
  }
}
