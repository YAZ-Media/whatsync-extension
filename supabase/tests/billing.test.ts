import { handleBilling } from '../functions/billing/handler.ts';
import { canManageBilling,hasPaidAccess,canMutateCrm,isPlan } from '../functions/_shared/billing-policy.ts';
import Stripe from 'npm:stripe@18.5.0';
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
 Deno.env.set('STRIPE_PRICE_STARTER','price_fixture');
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
 const oldFetch=globalThis.fetch;let checkoutBody='';Deno.env.set('BILLING_SALES_ENABLED','true');Deno.env.set('STRIPE_PRICE_STARTER','price_fixture');
 globalThis.fetch=async(input:RequestInfo|URL,init?:RequestInit)=>{
 const url=String(input);let result:unknown;
 if(url.includes('/auth/v1/user'))result={id:'user-1'};
 else if(url.includes('/user_profiles'))result={role:'Owner',status:'Active',organization_id:'org-1',email:'owner@example.com'};
 else if(url.includes('/billing_customers'))result={stripe_customer_id:'cus_fixture'};
 else if(url.includes('api.stripe.com/v1/subscriptions'))result={data:[]};
 else if(url.includes('api.stripe.com/v1/checkout/sessions')){checkoutBody=String(init?.body);result={url:'https://checkout.stripe.com/c/pay/fixture'};}
 else throw new Error('Unexpected request: '+url);
 return new Response(JSON.stringify(result),{headers:{'content-type':'application/json'}});
 };
 try {
 const auth={Authorization:'Bearer fixture'};
 equal((await handleBilling(request('createCheckoutSession',{planName:'Starter',amount:1,price:'evil_price'},auth))).status,200);
 const encoded=new URLSearchParams(checkoutBody);equal(encoded.get('line_items[0][price]'),'price_fixture');equal(encoded.get('line_items[0][quantity]'),'1');
 equal((await handleBilling(request('processPayment',{cardNumber:'fixture-card'},auth))).status,410);
 equal((await handleBilling(request('createCheckoutSession',{planName:'Free'},auth))).status,400);
 } finally {globalThis.fetch=oldFetch;Deno.env.set('BILLING_SALES_ENABLED','false');}
});
