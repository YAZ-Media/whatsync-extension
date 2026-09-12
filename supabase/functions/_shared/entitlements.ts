import { isOperator } from './operator.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { canMutateCrm, hasPaidAccess } from './billing-policy.ts';
export async function getWorkspaceAccess(userId:string, includeSubscription=true) {
 const ext=createClient(Deno.env.get('EXTERNAL_SUPABASE_URL')!,Deno.env.get('EXTERNAL_SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false,autoRefreshToken:false}});
 const {data:profile,error}=await ext.from('user_profiles').select('role,status,organization_id').eq('user_id',userId).maybeSingle();
 if(error) throw new Error('We couldn’t check workspace access. Please retry.');
 if(!profile || profile.status!=='Active') return {canRead:false,roleAllowed:false,canWrite:false,state:'suspended',message:'Your workspace access is suspended. Contact your workspace owner.'};
 if (isOperator(userId)) return {canRead:true,roleAllowed:true,canWrite:true,state:'internal',message:'Internal owner access — full access for your account. No customer subscription is being simulated.'};
 const roleAllowed=canMutateCrm(profile.role,profile.status);
 if (!includeSubscription) return {canRead:true,roleAllowed,canWrite:false,state:'view',message:'Your workspace role does not allow this change.'};
 const {data:subs,error:subError}=await ext.from('billing_subscriptions').select('status,current_period_end,livemode').eq('account_id',profile.organization_id||userId);
 if(subError) throw new Error('We couldn’t check your subscription. Please retry.');
 const live=Deno.env.get('BILLING_REQUIRE_LIVE')==='true';
 const current=subs?.find(s=>(!live||s.livemode)&&hasPaidAccess(s.status,s.current_period_end));
 return {canRead:true,roleAllowed,canWrite:!!current&&roleAllowed,state:current?.status || (subs?.length?'inactive':'no_plan'),message:!current?'CRM updates are paused. Choose or renew a plan in Billing to continue.':!roleAllowed?'Your workspace role allows viewing only.':'CRM updates are enabled.'};
}
export async function assertWorkspaceAccess(userId:string, mutation:boolean, requiresSubscription=true) {
 const access=await getWorkspaceAccess(userId, mutation && requiresSubscription);
 if(!access.canRead || (mutation && !access.roleAllowed) || (mutation && requiresSubscription && !access.canWrite)) throw new Error(access.message);
 // Settings remain available before purchasing; their own handlers enforce edit roles.
}
