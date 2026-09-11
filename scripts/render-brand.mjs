import {chromium} from '../website/node_modules/playwright-core/index.mjs';
import {readFile,writeFile} from 'node:fs/promises';
const browser=await chromium.launch({headless:true});const page=await browser.newPage({deviceScaleFactor:1});
const svg=await readFile(new URL('../icons/mark.svg',import.meta.url),'utf8');
for(const size of [16,32,48,128]){
 await page.setViewportSize({width:size,height:size});await page.setContent(`<style>html,body{margin:0;width:100%;height:100%}svg{width:100%;height:100%;display:block}</style>${svg}`);
 const png=await page.screenshot({omitBackground:true});await writeFile(new URL(`../icons/icon${size}.png`,import.meta.url),png);
 if(size===32){
  await writeFile(new URL('../website/public/favicon-32.png',import.meta.url),png);
  const header=Buffer.alloc(22);header.writeUInt16LE(1,2);header.writeUInt16LE(1,4);header[6]=32;header[7]=32;header.writeUInt16LE(1,10);header.writeUInt16LE(32,12);header.writeUInt32LE(png.length,14);header.writeUInt32LE(22,18);
  await writeFile(new URL('../website/public/favicon.ico',import.meta.url),Buffer.concat([header,png]));
 }
}
await page.setViewportSize({width:1200,height:630});await page.setContent(`<style>*{box-sizing:border-box}body{margin:0;background:#fff6f0;color:#213343;font-family:Arial;padding:75px}header{display:flex;align-items:center;gap:20px;font-size:34px;font-weight:700}svg{width:65px;height:65px}h1{font-size:76px;letter-spacing:-3px;line-height:1.06;margin:65px 0 24px}h1 span{color:#b94025}p{font-size:25px;color:#516574}.bar{position:absolute;left:0;right:0;bottom:0;height:20px;background:linear-gradient(110deg,#ff7a59,#ffad85)}</style><header>${svg}WhatSync</header><h1>Your conversations.<br><span>Your CRM, caught up.</span></h1><p>WhatsApp conversations. HubSpot context. One connected workflow.</p><div class="bar"></div>`);
await page.screenshot({path:new URL('../website/public/og-image.png',import.meta.url).pathname});await browser.close();
