import { createClient } from 'npm:@supabase/supabase-js@2';
import { canMutateCrm, hasPaidAccess } from './billing-policy.ts';
export async function assertWorkspaceAccess(userId:string, mutation:boolean) {
 const ext=createClient(Deno.env.get('EXTERNAL_SUPABASE_URL')!,Deno.env.get('EXTERNAL_SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false,autoRefreshToken:false}});
 const {data:profile,error}=await ext.from('user_profiles').select('role,status,organization_id').eq('user_id',userId).maybeSingle();
 if(error||!profile||profile.status!=='Active') throw new Error('An active workspace account is required.');
 if(mutation&&!canMutateCrm(profile.role,profile.status)) throw new Error('Your workspace role does not allow CRM changes.');
 // Rollout is explicit: never retroactively activate a legacy unverified subscription.
 if(mutation&&Deno.env.get('BILLING_ENFORCE_ACCESS')==='true') {
  const {data:subs,error:subError}=await ext.from('billing_subscriptions').select('status,current_period_end,livemode').eq('account_id',profile.organization_id||userId).in('status',['active','trialing']);
  const live=Deno.env.get('BILLING_REQUIRE_LIVE')==='true';
  if(subError||!subs?.some(s=>(!live||s.livemode)&&hasPaidAccess(s.status,s.current_period_end))) throw new Error('An active subscription is required. Open Billing in your workspace.');
 }
}
