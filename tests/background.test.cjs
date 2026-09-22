const {test}=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');const fs=require('node:fs');const {parse}=require('../website/node_modules/acorn');
const source=fs.readFileSync(require.resolve('../background.js'),'utf8');const ast=parse(source,{ecmaVersion:'latest'});
const functions=names=>ast.body.filter(n=>n.type==='FunctionDeclaration'&&names.includes(n.id.name)).map(n=>source.slice(n.start,n.end)).join('\n');
const quiet={log(){},warn(){},error(){}};
test('transient refresh outage preserves the session and does not look like rejection',async()=>{
 const ctx=vm.createContext({console:quiet,whatsyncDebug(){},getStoredRefreshToken:async()=>'refresh',fetchWithTimeout:async()=>({ok:false,status:503,text:async()=>'unavailable'}),SUPABASE_URL:'https://fixture',SUPABASE_ANON_KEY:'public'});
 vm.runInContext(functions(['doRefreshAccessToken']),ctx);
 await assert.rejects(ctx.doRefreshAccessToken('refresh'),/temporarily unavailable/);
});
test('a successful CRM save survives activity log and company association failure',async()=>{
 const actions=[];const settings={enrich_before_create:false,auto_create_companies:true};
 const ctx=vm.createContext({console:quiet,whatsyncDebug(){},getSyncSettingsForUser:async()=>settings,applyFieldMappings:(_,__,props)=>props,applyContactOwnerAssignment:async x=>x,callHubSpotEdgeFunction:async action=>{actions.push(action);if(action==='createContact')return {id:'123',properties:{company:'Acme'}};throw new Error('association denied');},logContactCreationToSupabase:async()=>{throw new Error('log unavailable')}});
 vm.runInContext(functions(['maybeCreateCompanyForContact','createHubSpotContactViaEdgeFunction']),ctx);
 const result=await ctx.createHubSpotContactViaEdgeFunction({properties:{company:'Acme'}},'u','session');assert.equal(result.id,'123');assert.match(result.whatsyncWarning,/Company linking failed/);assert.deepEqual(actions,['createContact','associateCompanyByName']);
});
test('HubSpot error-shaped or empty contact responses are never a saved contact',async()=>{
 const ctx=vm.createContext({console:quiet,whatsyncDebug(){},callHubSpotEdgeFunction:async()=>({success:true})});vm.runInContext(functions(['createHubSpotContactViaEdgeFunction']),ctx);
 await assert.rejects(ctx.createHubSpotContactViaEdgeFunction({properties:{}},null,null),/did not return/);
});

test('learned conditional fields are shown only for the matching HubSpot rule',()=>{
 const ctx=vm.createContext({});
 vm.runInContext(functions(['attachKnownConditionalFields']),ctx);
 const contacts=[{properties:{hs_lead_status:'QUALIFIED',lead_tier:'tier_3',disqualification_reason:'budget'}}];
 const result=ctx.attachKnownConditionalFields(contacts,[
  {name:'lead_tier',label:'Lead Tier',controllingProperty:'hs_lead_status',controllingValue:'QUALIFIED'},
  {name:'disqualification_reason',label:'Disqualification Reason',controllingProperty:'hs_lead_status',controllingValue:'UNQUALIFIED'},
 ]);
 assert.equal(result[0].whatsyncConditionalFields.length,1);
 assert.equal(result[0].whatsyncConditionalFields[0].name,'lead_tier');
 assert.equal(result[0].whatsyncConditionalFields[0].value,'tier_3');
});

test('conditional field definitions reject unsafe property names',()=>{
 const ctx=vm.createContext({});
 vm.runInContext(functions(['sanitizeConditionalPropertyDefinition']),ctx);
 assert.equal(ctx.sanitizeConditionalPropertyDefinition({name:'lead_tier'}).name,'lead_tier');
 assert.equal(ctx.sanitizeConditionalPropertyDefinition({name:'lead-tier<script>'}),null);
});
