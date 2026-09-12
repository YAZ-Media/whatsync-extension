import { handleExternalAuth } from '../functions/external-auth/handler.ts';
const equal=(actual:unknown,expected:unknown)=>{if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)};
for(const failure of [false,true]) Deno.test(`signup uses server privileges for workspace setup and reports database failure=${failure}`,async()=>{
 Deno.env.set('EXTERNAL_SUPABASE_URL','https://test-project.supabase.co');
 Deno.env.set('EXTERNAL_SUPABASE_SERVICE_ROLE_KEY','fixture-service-key');
 const savedFetch=globalThis.fetch;let savedProfile:any;
 globalThis.fetch=async(input:RequestInfo|URL,init?:RequestInit)=>{
  const url=String(input);
  if(url.includes('/auth/v1/signup'))return Response.json({access_token:'fixture-user-session',refresh_token:'fixture-refresh',expires_in:3600,token_type:'bearer',user:{id:'fixture-user',email:'buyer@example.com',aud:'authenticated'}});
  if(url.includes('/rest/v1/user_profiles')){
   if(init?.method==='POST'){
    equal(new Headers(init.headers).get('authorization'),'Bearer fixture-service-key');
    savedProfile=JSON.parse(String(init.body));
    return failure?Response.json({message:'denied',code:'42501'},{status:403}):new Response(null,{status:201});
   }
   return Response.json(null);
  }
  throw new Error('Unexpected provider request');
 };
 try {
  const response=await handleExternalAuth(new Request('https://test.local/auth',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'signUp',email:'buyer@example.com',password:'fixture-password',firstName:'Buyer',role:'Admin',organizationId:'another-workspace'})}));
  equal(response.status,failure?500:200);
  const body=await response.json();equal(!!body.error,failure);
  equal(savedProfile.role,'Owner');equal(savedProfile.organization_id,'fixture-user');
  if(failure)equal(body.session,undefined);
 } finally {globalThis.fetch=savedFetch;}
});
Deno.test('expired confirmation can request a fresh link without exposing account existence',async()=>{
 Deno.env.set('EXTERNAL_SUPABASE_URL','https://test-project.supabase.co');
 Deno.env.set('EXTERNAL_SUPABASE_SERVICE_ROLE_KEY','fixture-service-key');
 const savedFetch=globalThis.fetch;let resendBody='',resendUrl='';
 globalThis.fetch=async(input:RequestInfo|URL,init?:RequestInit)=>{
  const url=String(input);
  if(url.includes('/auth/v1/resend')){resendUrl=url;resendBody=String(init?.body);return Response.json({});}
  throw new Error('Unexpected provider request: '+url);
 };
 try {
  const response=await handleExternalAuth(new Request('https://test.local/auth',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'resendConfirmation',email:' Buyer@Example.com ',emailRedirectTo:'https://evil.example/capture'})}));
  equal(response.status,200);const body=await response.json();equal(body.success,true);
  const provider=JSON.parse(resendBody);equal(provider.email,'buyer@example.com');equal(new URL(resendUrl).searchParams.get('redirect_to'),'https://whatsync.io/auth/callback');
 } finally {globalThis.fetch=savedFetch;}
});
