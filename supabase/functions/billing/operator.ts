import Stripe from 'npm:stripe@18.5.0';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { PLAN_KEYS, planPriceEnvKey } from '../_shared/billing-policy.ts';
import { isOperator } from '../_shared/operator.ts';
const env=(key:string)=>Deno.env.get(key)||'';
function checked<T extends {error:unknown}>(result:T):T { if(result.error) throw new Error('Internal account data is unavailable. Please retry.');return result; }
export async function operatorAction(action:string,data:Record<string,unknown>,userId:string,db:SupabaseClient) {
 if (!isOperator(userId)) throw new Error('Operator access required.');
 if(action==='getOperatorOverview') {
  const [users,active,connections,paid,errors,events]=await Promise.all([
   db.from('user_profiles').select('user_id',{count:'exact',head:true}),
   db.from('user_profiles').select('user_id',{count:'exact',head:true}).eq('status','Active'),
   db.from('hubspot_connections').select('id',{count:'exact',head:true}).in('status',['active','connected']),
   db.from('billing_subscriptions').select('account_id',{count:'exact',head:true}).eq('livemode',true).in('status',['active','trialing']).gt('current_period_end',new Date().toISOString()),
   db.from('client_errors').select('id,user_id,context,extension_version,created_at').order('created_at',{ascending:false}).limit(20),
   db.from('billing_webhook_events').select('event_id,processed_at').order('processed_at',{ascending:false}).limit(10),
  ]);
  [users,active,connections,paid,errors,events].forEach(checked);
  return {users:users.count,activeUsers:active.count,connectedUsers:connections.count,liveSubscriptions:paid.count,recentErrors:errors.data,recentBillingEvents:events.data};
 }
 if(action==='listOperatorAccounts') {
  const page=Math.max(0,Math.min(Math.floor(Number(data.page)||0),10000));
  let query=db.from('user_profiles').select('user_id,email,first_name,last_name,company,role,status,organization_id,last_active,extension_version,created_at',{count:'exact'}).order('created_at',{ascending:false}).order('user_id');
  const search=String(data.search||'').trim().slice(0,120);
  if(search) query=query.ilike('email',`%${search.replace(/[\\%_]/g,'\\$&')}%`);
  const users=checked(await query.range(page*50,page*50+49));
  const ids=(users.data||[]).map(u=>u.user_id);
  const connections=ids.length?checked(await db.from('hubspot_connections').select('user_id,status,portal_id,connected_at').in('user_id',ids)).data:[];
  return {accounts:(users.data||[]).map(u=>({...u,isOperator:isOperator(u.user_id),connection:connections?.find(c=>c.user_id===u.user_id)||null})),total:users.count,page};
 }
 if(action==='getBillingHealth') {
  const configured={apiKey:!!env('STRIPE_SECRET_KEY'),webhookSecret:!!env('STRIPE_WEBHOOK_SECRET'),portal:!!env('STRIPE_PORTAL_CONFIGURATION_ID'),prices:PLAN_KEYS.map(name=>({name,configured:!!env(planPriceEnvKey(name))}))};
  const base={configured,salesEnabled:env('BILLING_SALES_ENABLED')==='true',requireLive:env('BILLING_REQUIRE_LIVE')==='true'};
  if(!configured.apiKey) return {...base,ready:false,mode:'unconfigured',message:'Connect Stripe to enable payment checks.'};
  try {
   const stripe=new Stripe(env('STRIPE_SECRET_KEY'),{httpClient:Stripe.createFetchHttpClient(),maxNetworkRetries:1});
   const account=await stripe.accounts.retrieve();
   const prices=await Promise.all(PLAN_KEYS.map(async name=>{
    const id=env(planPriceEnvKey(name));if(!id)return {name,valid:false,livemode:false};
    const p=await stripe.prices.retrieve(id);return {name,valid:p.active&&!!p.recurring&&p.unit_amount!==null,livemode:p.livemode,amount:p.unit_amount,currency:p.currency,interval:p.recurring?.interval};
   }));
   const hooks=await stripe.webhookEndpoints.list({limit:100});
   const endpoint=hooks.data.find(h=>h.url==='https://ogsvchujqpayuckxuwdf.supabase.co/functions/v1/billing');
   const required=['customer.subscription.created','customer.subscription.updated','customer.subscription.deleted','invoice.paid','invoice.payment_failed','checkout.session.completed'];
   const webhookValid=endpoint?.status==='enabled' && required.every(e=>endpoint.enabled_events.includes('*') || (endpoint.enabled_events as string[]).includes(e));
   const portal=configured.portal
    ? await stripe.billingPortal.configurations.retrieve(env('STRIPE_PORTAL_CONFIGURATION_ID'))
    : (await stripe.billingPortal.configurations.list({limit:100})).data.find(configuration=>configuration.active&&configuration.is_default) || null;
   const accountMatches=account.id===env('STRIPE_ACCOUNT_ID');
   const ready=accountMatches&&!!account.charges_enabled&&!!account.details_submitted&&prices.every(p=>p.valid&&p.livemode)&&!!webhookValid&&!!endpoint?.livemode&&configured.webhookSecret&&!!portal?.active&&base.requireLive;
   return {...base,ready,mode:prices.some(p=>p.livemode)?'live':'test',account:{id:account.id,matchesExpected:accountMatches,chargesEnabled:account.charges_enabled,payoutsEnabled:account.payouts_enabled,detailsSubmitted:account.details_submitted},prices,webhook:{registered:!!endpoint,eventsConfigured:!!webhookValid,livemode:endpoint?.livemode||false},portalReady:!!portal?.active,message:ready?'Configuration checks passed. Complete a real sandbox checkout and cancellation before opening sales.':'Payment setup is incomplete or in test mode.'};
  } catch {return {...base,ready:false,mode:'unknown',message:'Stripe could not be verified. Check the key, permissions, account and configured prices.'};}
 }
 throw new Error('Unknown operator action');
}
