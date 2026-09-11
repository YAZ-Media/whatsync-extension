const { test }=require('node:test');
const assert=require('node:assert/strict');
const {suggest}=require('../contact-intelligence');
const incoming=text=>({id:'1',text,direction:'incoming'});
test('article headlines, link domains and third-party CEOs never become contact data',()=>{
 assert.deepEqual(suggest([incoming('Sarah Shaw, CEO of Majra, on Aligning Business Impact. This is economy. https://example.com')]),[]);
});
test('explicit introduction preserves the full company name',()=>{
 const fields=Object.fromEntries(suggest([incoming('Hi, This is Kayal from Amplus Mortgage Consultants.')]).map(s=>[s.field,s.value]));
 assert.equal(fields.firstName,'Kayal');assert.equal(fields.company,'Amplus Mortgage Consultants');assert.equal(fields.jobTitle,undefined);
});
test('outgoing and forwarded messages cannot populate customer fields',()=>{
 assert.deepEqual(suggest([{...incoming('I am the CEO at Other Inc.'),direction:'outgoing'},{...incoming('My email is colleague@example.com'),forwarded:true}]),[]);
});
test('email is explicit, excludes own email and leaves ambiguous addresses for review',()=>{
 assert.equal(suggest([incoming('kayal@example.com')])[0].value,'kayal@example.com');
 assert.deepEqual(suggest([incoming('kayal@example.com')],'kayal@example.com'),[]);
 assert.deepEqual(suggest([incoming('Send this to bob@example.com and mary@example.com')]),[]);
 assert.deepEqual(suggest([incoming('The CEO is bob@example.com')]),[]);
});
test('job title requires a first-person statement',()=>{
 assert.deepEqual(suggest([incoming('Our CEO will review it')]),[]);
 const result=suggest([incoming('I am a Marketing Manager at Globex.')]);
 assert.equal(result.find(s=>s.field==='jobTitle').value,'Marketing Manager');
 assert.equal(result.find(s=>s.field==='company').value,'Globex');
});
test('multiple values are retained for user choice rather than last match wins',()=>{
 const result=suggest([incoming('old@example.com'),{...incoming('new@example.com'),id:'2'}]);assert.equal(result.length,2);
});
test('unknown direction and unsupported prose fail closed',()=>{
 assert.deepEqual(suggest([{...incoming('My email is x@example.com'),direction:'unknown'},incoming("I'm looking for a designer.")]),[]);
});

test('short company introductions do not become a last name',()=>{
 const fields=Object.fromEntries(suggest([incoming('This is Kayal from Acme.')]).map(s=>[s.field,s.value]));
 assert.equal(fields.firstName,'Kayal');assert.equal(fields.company,'Acme');assert.equal(fields.lastName,undefined);
});

test('template variables resolve real fields and report missing values',()=>{
 const {renderTemplate}=require('../contact-intelligence');
 assert.deepEqual(renderTemplate('Hi {{first_name}}, at {{company}}. {{owner}}',{first_name:'Mary',company:'Acme'}),{text:'Hi Mary, at Acme. {{owner}}',missing:['owner']});
 assert.equal(renderTemplate('{{email}}',{email:'test@example.com'}).text,'test@example.com');
});
