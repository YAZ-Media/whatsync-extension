import {chromium} from '../website/node_modules/playwright-core/index.mjs';
import {writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const browser=await chromium.launch({headless:true});
try {
 const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/functions/v1/*',route=>route.fulfill({json:{salesEnabled:false,plans:[]}}));
 const paths=['/','/setup','/auth','/pricing','/privacy','/dashboard/billing'];
 for(const path of paths){await page.goto('http://127.0.0.1:4175'+path);await page.locator('h1').first().waitFor();if(path==='/dashboard/billing')assert.match(page.url(),/\/auth$/);}
 assert.deepEqual(errors,[]);
 await page.goto('http://127.0.0.1:4175/');await page.getByRole('heading',{name:'Your conversations. Your CRM, caught up.'}).waitFor();
 await page.screenshot({path:'website/test-results/website-desktop.png',animations:'disabled'});
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:'website/test-results/website-mobile.png',animations:'disabled'});
 await writeFile('/tmp/whatsync-compiled-tests.json',JSON.stringify({passed:true,paths,pageErrors:errors,mode:'compiled production assets; billing response mocked'},null,2));
 console.log('PASS: compiled production routes, protected redirect and page error checks');
} finally {await browser.close()}
