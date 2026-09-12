import { handleBilling } from '../functions/billing/handler.ts';
import { canManageBilling,hasPaidAccess,canMutateCrm,isPlan } from '../functions/_shared/billing-policy.ts';
import Stripe from 'npm:stripe@18.5.0';
import { selectActivePortalConfiguration } from '../functions/billing/operator.ts';
const equal=(actual:unknown,expected:unknown)=>{if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)};
Deno.env.set('BILLING_SALES_ENABLED','false');
Deno.env.set('EXTERNAL_SUPABASE_URL','https://test-project.supabase.co');
Deno.env.set('EXTERNAL_SUPABASE_SERVICE_ROLE_KEY','test-service-key');
Deno.env.set('STRIPE_SECRET_KEY','sk_test_fixture');
Deno.env.set('STRIPE_WEBHOOK_SECRET','whsec_fixture');
const request=(action:string,data:Record<string,unknown>={},headers:Record<string,string>={})=>new Request('https://test.local/billing',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify({action,data})});
Deno.test('sales remain closed unless explicitly configured',async()=>{
 const r=await handleBilling(request('getPlans'));equal(r.status,200);equal(await r.json(),{salesEnabled:false,plans:[]});
});
Deno.test('billing health accepts Stripe active portal when the list omits a default marker',()=>{
 equal(selectActivePortalConfiguration([{id:'inactive',active:false},{id:'active',active:true}]),{id:'active',active:true});
 equal(selectActivePortalConfiguration([]),null);
});
Deno.test('CORS preflight has no body and methods are bounded',async()=>{
 const r=await handleBilling(new Request('https://test.local/billing',{method:'OPTIONS'}));equal(r.status,204);equal(await r.text(),'');equal((await handleBilling(new Request('https://test.local/billing'))).status,405);
});
Deno.test('billing and admin endpoints require authentication',async()=>{
 for(const action of ['listSubscribers','getBillingData','createCheckoutSession','processPayment','savePaymentMethod'])equal((await handleBilling(request(action))).status,401);
});
Deno.test('subscription and role policy rejects expired, unpaid and read-only access',()=>{
 equal(canManageBilling('Owner','Active'),true);equal(canManageBilling('Admin','Active'),false);equal(canManageBilling('Billing','Suspended'),false);
 equal(canMutateCrm('Read-only','Active'),false);equal(canMutateCrm('Member','Active'),true);equal(canMutateCrm('Owner','Suspended'),false);
 equal(hasPaidAccess('active','2030-01-01',0),true);equal(hasPaidAccess('past_due','2030-01-01',0),false);equal(hasPaidAccess('active','2020-01-01'),false);equal(hasPaidAccess('trialing',null),false);equal(isPlan('Free'),false);
});
Deno.test('forged webhook is rejected before a database write',async()=>{
 const r=await handleBilling(new Request('https://test.local/billing',{method:'POST',headers:{'stripe-signature':'t=1,v1=bad'},body:'{}'}));equal(r.status,400);
});
Deno.test('valid signed unrelated webhook is acknowledged without granting access',async()=>{
 const stripe=new Stripe('sk_test_fixture');const body=JSON.stringify({id:'evt_fixture',type:'unrelated.event',data:{object:{}},created:Math.floor(Date.now()/1000)});
 const signature=await stripe.webhooks.generateTestHeaderStringAsync({payload:body,secret:'whsec_fixture',cryptoProvider:Stripe.createSubtleCryptoProvider()});
 const r=await handleBilling(new Request('https://test.local/billing',{method:'POST',headers:{'stripe-signature':signature},body}));equal(r.status,200);equal(await r.json(),{received:true});
});
Deno.test('workspace owner cannot access global subscribers or spoof a userId',async()=>{
 const oldFetch=globalThis.fetch;globalThis.fetch=async(input:RequestInfo|URL)=>{
 const url=String(input);if(url.includes('/auth/v1/user'))return new Response(JSON.stringify({id:'user-1'}));
 if(url.includes('/user_profiles'))return new Response(JSON.stringify({role:'Owner',status:'Active',organization_id:'org-1',email:'owner@example.com'}),{headers:{'content-type':'application/json'}});
 throw new Error('Unexpected external request');
 };
 try {equal((await handleBilling(request('listSubscribers',{}, {Authorization:'Bearer test-user'}))).status,403);equal((await handleBilling(request('getBillingData',{userId:'another-user'},{Authorization:'Bearer test-user'}))).status,403);}finally{globalThis.fetch=oldFetch;}
});
Deno.test('signed subscription event persists provider state, ignores forged snapshot, and retries failed storage',async()=>{
 const oldFetch=globalThis.fetch;let persisted:Record<string,unknown>|null=null;let fail=false;
 Deno.env.set('STRIPE_PRICE_PRO_MONTHLY','price_fixture');
 globalThis.fetch=async(input:RequestInfo|URL,init?:RequestInit)=>{
  const url=String(input);
  if(url.includes('/billing_customers'))return new Response(JSON.stringify({account_id:'org-fixture'}),{headers:{'content-type':'application/json'}});
  if(url.includes('api.stripe.com/v1/subscriptions/sub_fixture'))return new Response(JSON.stringify({id:'sub_fixture',customer:'cus_fixture',status:'past_due',cancel_at_period_end:false,livemode:false,items:{data:[{price:{id:'price_fixture',currency:'usd',unit_amount:2900},current_period_end:2000000000}]}}),{headers:{'content-type':'application/json'}});
  if(url.includes('/rpc/apply_billing_event')){persisted=JSON.parse(String(init?.body));return fail?new Response(JSON.stringify({message:'Database unavailable'}),{status:503,headers:{'content-type':'application/json'}}):new Response(null,{status:204});}
  throw new Error('Unexpected request: '+url);
 };
 try {
  const stripe=new Stripe('sk_test_fixture');const body=JSON.stringify({id:'evt_subscription',type:'customer.subscription.updated',created:Math.floor(Date.now()/1000),data:{object:{id:'sub_fixture',customer:'cus_fixture',status:'active'}}});
  const signature=await stripe.webhooks.generateTestHeaderStringAsync({payload:body,secret:'whsec_fixture',cryptoProvider:Stripe.createSubtleCryptoProvider()});
  const signed=()=>new Request('https://test.local/billing',{method:'POST',headers:{'stripe-signature':signature},body});
  equal((await handleBilling(signed())).status,200);equal((persisted as any)?.p_snapshot.status,'past_due');equal((persisted as any)?.p_snapshot.account_id,'org-fixture');
  fail=true;equal((await handleBilling(signed())).status,500);
 } finally {globalThis.fetch=oldFetch;}
});
Deno.test('checkout uses the server price and blocks legacy card submissions',async()=>{
 const oldFetch=globalThis.fetch;let checkoutBody='';let checkoutKey='';Deno.env.set('BILLING_SALES_ENABLED','true');Deno.env.set('STRIPE_PRICE_PRO_MONTHLY','price_fixture');
 globalThis.fetch=async(input:RequestInfo|URL,init?:RequestInit)=>{
 const url=String(input);let result:unknown;
 if(url.includes('/auth/v1/user'))result={id:'user-1'};
 else if(url.includes('/user_profiles'))result={role:'Owner',status:'Active',organization_id:'org-1',email:'owner@example.com'};
 else if(url.includes('/billing_customers'))result={stripe_customer_id:'cus_fixture'};
 else if(url.includes('/rpc/reserve_billing_checkout'))result={attempt_id:'stable-attempt',plan_name:'Pro Monthly',seats:3,expires_at:2000000000};
 else if(url.includes('api.stripe.com/v1/subscriptions'))result={data:[]};
 else if(url.includes('api.stripe.com/v1/checkout/sessions')){checkoutBody=String(init?.body);checkoutKey=new Headers(init?.headers).get('Idempotency-Key')||'';result={url:'https://checkout.stripe.com/c/pay/fixture'};}
 else throw new Error('Unexpected request: '+url);
 return new Response(JSON.stringify(result),{headers:{'content-type':'application/json'}});
 };
 try {
 const auth={Authorization:'Bearer fixture'};
 equal((await handleBilling(request('createCheckoutSession',{planName:'Pro Monthly',seats:3},auth))).status,400);
 equal((await handleBilling(request('createCheckoutSession',{planName:'Pro Monthly',seats:3,termsAccepted:true,amount:1,price:'evil_price'},auth))).status,200);
 const encoded=new URLSearchParams(checkoutBody);equal(encoded.get('line_items[0][price]'),'price_fixture');equal(encoded.get('line_items[0][quantity]'),'3');equal(encoded.get('line_items[0][adjustable_quantity][minimum]'),'1');
 equal(checkoutKey,'checkout-stable-attempt');equal(encoded.get('expires_at'),'2000000000');
 Deno.env.set('BILLING_SALES_ENABLED','false');Deno.env.set('BILLING_ACCEPTANCE_EMAILS','owner@example.com');
 equal(await (await handleBilling(request('getPlans'))).json(),{salesEnabled:false,plans:[]});
 equal((await handleBilling(request('createCheckoutSession',{planName:'Pro Monthly',seats:3,termsAccepted:true},auth))).status,200);
 const originalNow=Date.now;
 try {
  Date.now=()=>originalNow()+1800001;
  equal((await handleBilling(request('createCheckoutSession',{planName:'Pro Monthly',seats:3,termsAccepted:true},auth))).status,200);
  equal(checkoutKey,'checkout-stable-attempt');equal(new URLSearchParams(checkoutBody).get('expires_at'),'2000000000');
 } finally {Date.now=originalNow;}
 equal((await handleBilling(request('processPayment',{cardNumber:'fixture-card'},auth))).status,410);
 equal((await handleBilling(request('createCheckoutSession',{planName:'Free'},auth))).status,400);
 Deno.env.set('STRIPE_PRICE_PRO_ANNUAL','price_annual');
 equal((await handleBilling(request('createCheckoutSession',{planName:'Pro Annual',seats:3,termsAccepted:true},auth))).status,409);
 } finally {globalThis.fetch=oldFetch;Deno.env.set('BILLING_SALES_ENABLED','false');Deno.env.delete('BILLING_ACCEPTANCE_EMAILS');}
});
Deno.test('acceptance checkout uses isolated test Stripe resources without changing live billing',async()=>{
 const oldFetch=globalThis.fetch;let checkoutBody='',checkoutAuth='',customerWrite:Record<string,unknown>|null=null;
 Deno.env.set('BILLING_ACCEPTANCE_EMAILS','acceptance@example.com');
 Deno.env.set('BILLING_ACCEPTANCE_TEST_ENABLED','true');
 Deno.env.set('STRIPE_TEST_SECRET_KEY','sk_test_acceptance');
 Deno.env.set('STRIPE_TEST_PRICE_PRO_MONTHLY','price_test_monthly');
 globalThis.fetch=async(input:RequestInfo|URL,init?:RequestInit)=>{
  const url=String(input);let result:unknown;
  if(url.includes('/auth/v1/user'))result={id:'acceptance-user'};
  else if(url.includes('/user_profiles')&&url.includes('select=role'))result={role:'Owner',status:'Active',organization_id:'acceptance-org',email:'acceptance@example.com'};
  else if(url.includes('/user_profiles'))return new Response(null,{headers:{'content-range':'0-0/1'}});
  else if(url.includes('/billing_customers')&&init?.method==='POST'){customerWrite=JSON.parse(String(init.body));result=customerWrite;}
  else if(url.includes('/billing_customers'))result={stripe_customer_id:'cus_live_old',livemode:true};
  else if(url.includes('/rpc/reserve_billing_checkout'))result={attempt_id:'acceptance-attempt',plan_name:'Pro Monthly',seats:1,expires_at:2000000000};
  else if(url.includes('api.stripe.com/v1/customers'))result={id:'cus_test_acceptance'};
  else if(url.includes('api.stripe.com/v1/subscriptions'))result={data:[]};
  else if(url.includes('api.stripe.com/v1/checkout/sessions')){checkoutBody=String(init?.body);checkoutAuth=new Headers(init?.headers).get('Authorization')||'';result={url:'https://checkout.stripe.com/c/pay/test-fixture'};}
  else throw new Error('Unexpected request: '+url);
  return new Response(JSON.stringify(result),{headers:{'content-type':'application/json'}});
 };
 try {
  const response=await handleBilling(request('createCheckoutSession',{planName:'Pro Monthly',seats:1,termsAccepted:true},{Authorization:'Bearer fixture'}));
  equal(response.status,200);
  const encoded=new URLSearchParams(checkoutBody);
  equal(encoded.get('line_items[0][price]'),'price_test_monthly');
  equal(encoded.get('metadata[environment]'),'acceptance_test');
  equal(checkoutAuth,'Bearer sk_test_acceptance');
  equal((customerWrite as Record<string,unknown>|null)?.livemode,false);
 } finally {
  globalThis.fetch=oldFetch;
  for(const key of ['BILLING_ACCEPTANCE_EMAILS','BILLING_ACCEPTANCE_TEST_ENABLED','STRIPE_TEST_SECRET_KEY','STRIPE_TEST_PRICE_PRO_MONTHLY'])Deno.env.delete(key);
 }
});
Deno.test('seat changes enforce active members and use Stripe pending updates with proration',async()=>{
 const oldFetch=globalThis.fetch;let stripeBody='';Deno.env.set('STRIPE_PRICE_PRO_MONTHLY','price_fixture');Deno.env.set('BILLING_REQUIRE_LIVE','true');
 globalThis.fetch=async(input:RequestInfo|URL,init?:RequestInit)=>{
  const url=String(input);let result:unknown;
  if(url.includes('/auth/v1/user'))result={id:'user-1'};
  else if(url.includes('/user_profiles')&&url.includes('select=role'))result={role:'Owner',status:'Active',organization_id:'org-1',email:'owner@example.com'};
  else if(url.includes('/user_profiles'))return new Response(null,{headers:{'content-range':'0-1/2'}});
  else if(url.includes('/billing_customers'))result={stripe_customer_id:'cus_fixture'};
  else if(url.includes('/billing_subscriptions'))result={stripe_subscription_id:'sub_fixture',status:'active',quantity:2,livemode:true};
  else if(url.includes('api.stripe.com/v1/subscriptions/sub_fixture')&&init?.method==='POST'){
   stripeBody=String(init.body);result={id:'sub_fixture',customer:'cus_fixture',items:{data:[{id:'si_fixture',quantity:3,price:{id:'price_fixture'}}]}};
  }
  else if(url.includes('api.stripe.com/v1/subscriptions/sub_fixture'))result={id:'sub_fixture',customer:'cus_fixture',items:{data:[{id:'si_fixture',quantity:2,price:{id:'price_fixture'}}]}};
  else throw new Error('Unexpected request: '+url);
  return new Response(JSON.stringify(result),{headers:{'content-type':'application/json'}});
 };
 try {
  const auth={Authorization:'Bearer fixture'};
  equal((await handleBilling(request('updateSubscriptionSeats',{seats:1},auth))).status,400);
  const response=await handleBilling(request('updateSubscriptionSeats',{seats:3},auth));equal(response.status,200);equal((await response.json()).quantity,3);
  const body=new URLSearchParams(stripeBody);equal(body.get('items[0][quantity]'),'3');equal(body.get('proration_behavior'),'always_invoice');equal(body.get('payment_behavior'),'pending_if_incomplete');
 } finally {globalThis.fetch=oldFetch;Deno.env.delete('BILLING_REQUIRE_LIVE');}
});
Deno.test('live workspace enforcement denies no-plan, expired, overdue, suspended and read-only writes',async()=>{
 const {assertWorkspaceAccess,getWorkspaceAccess}=await import('../functions/_shared/entitlements.ts');
 const oldFetch=globalThis.fetch;let status='Active',role='Owner',subs:unknown[]=[];
 Deno.env.delete('BILLING_ENFORCE_ACCESS');
 globalThis.fetch=async(input:RequestInfo|URL)=>{
 const url=String(input);return new Response(JSON.stringify(url.includes('user_profiles')?{role,status,organization_id:'org-1'}:subs),{headers:{'content-type':'application/json'}});
 };
 const denied=async()=>{let rejected=false;try{await assertWorkspaceAccess('u',true);}catch{rejected=true;}equal(rejected,true);};
 try {
  await denied();await assertWorkspaceAccess('u',false);await assertWorkspaceAccess('u',true,false);
  for(const s of ['past_due','unpaid','canceled','paused']) {subs=[{status:s,current_period_end:'2035-01-01',livemode:true}];await denied();}
  subs=[{status:'active',current_period_end:'2020-01-01',livemode:true}];await denied();
  for(const s of ['active','trialing']){subs=[{status:s,current_period_end:'2035-01-01',livemode:true}];await assertWorkspaceAccess('u',true);}
  role='Read-only';await denied();role='Owner';status='Suspended';equal((await getWorkspaceAccess('u')).canRead,false);await denied();
 }finally{globalThis.fetch=oldFetch;}
});
Deno.test('internal owner access requires the exact server UUID and an active account',async()=>{
 const {getWorkspaceAccess}=await import('../functions/_shared/entitlements.ts');const oldFetch=globalThis.fetch;
 const prior=Deno.env.get('BILLING_ADMIN_USER_IDS');Deno.env.set('BILLING_ADMIN_USER_IDS','internal-owner');let status='Active';
 globalThis.fetch=async(input:RequestInfo|URL)=>new Response(JSON.stringify(String(input).includes('user_profiles')?{role:'Owner',status,organization_id:null}:[]),{headers:{'content-type':'application/json'}});
 try {equal((await getWorkspaceAccess('internal-owner')).state,'internal');equal((await getWorkspaceAccess('ordinary-owner')).canWrite,false);status='Suspended';equal((await getWorkspaceAccess('internal-owner')).canRead,false);}finally{globalThis.fetch=oldFetch;prior===undefined?Deno.env.delete('BILLING_ADMIN_USER_IDS'):Deno.env.set('BILLING_ADMIN_USER_IDS',prior);}
});
Deno.test('operator endpoints deny customer owners and expose no credentials to the internal owner',async()=>{
 const oldFetch=globalThis.fetch;const prior=Deno.env.get('BILLING_ADMIN_USER_IDS');const key=Deno.env.get('STRIPE_SECRET_KEY');Deno.env.set('STRIPE_SECRET_KEY','');Deno.env.set('BILLING_ADMIN_USER_IDS','internal-owner');let uid='customer-owner';
 globalThis.fetch=async(input:RequestInfo|URL)=>{
  const url=String(input);
  if(url.includes('/auth/v1/user'))return new Response(JSON.stringify({id:uid}));
  if(url.includes('/user_profiles'))return new Response(JSON.stringify({role:'Owner',status:'Active',organization_id:'org-1',email:'owner@example.com'}),{headers:{'content-type':'application/json'}});
  throw new Error('Unexpected request');
 };
 try {
  for(const action of ['getBillingHealth','getOperatorOverview','listOperatorAccounts'])equal((await handleBilling(request(action,{}, {Authorization:'Bearer fixture'}))).status,403);
  uid='internal-owner';const r=await handleBilling(request('getBillingHealth',{}, {Authorization:'Bearer fixture'}));equal(r.status,200);const result=await r.json();equal(result.ready,false);equal(result.mode,'unconfigured');equal(result.configured.apiKey,false);equal(JSON.stringify(result).includes('sk_test'),false);
 }finally{globalThis.fetch=oldFetch;prior===undefined?Deno.env.delete('BILLING_ADMIN_USER_IDS'):Deno.env.set('BILLING_ADMIN_USER_IDS',prior);key===undefined?Deno.env.delete('STRIPE_SECRET_KEY'):Deno.env.set('STRIPE_SECRET_KEY',key);}
});
