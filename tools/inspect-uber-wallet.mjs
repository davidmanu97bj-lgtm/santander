// End-to-end UI regression using new browser processes and two local MemoryStores.
// No production credentials or production network are used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {chromium,webkit} from 'playwright';
import {ROOT} from './project.mjs';
import {adminUberWeek} from '../admin-uber-liquidation-ui.js';

const output=path.resolve(ROOT,'../qa-uber-wallet');
fs.mkdirSync(output,{recursive:true});
const runtime=fs.mkdtempSync(path.join(os.tmpdir(),'explora-uber-wallet-'));
const report={cases:[],errors:[],blocked:[]};
const endpoints=[];
async function preview(role){
  process.env.PREVIEW_ROLE=role;
  process.env.PREVIEW_STATE_PATH=path.join(runtime,role+'.json');
  const {server}=await import(`./preview.mjs?uber-wallet-qa=${role}-${Date.now()}`);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const api=async(body,allowError=false)=>{
    const response=await fetch(origin+'/__preview__/api',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const data=await response.json();
    if(!allowError)assert.ok(response.ok,JSON.stringify(data));
    return allowError?{ok:response.ok,data}:data;
  };
  const endpoint={server,origin,api};endpoints.push(endpoint);return endpoint;
}
const week=adminUberWeek();
const previousWeek=new Date(week.weekStartDate+'T12:00:00Z');previousWeek.setUTCDate(previousWeek.getUTCDate()-7);
const legacy={uid:'preview-driver',driverUid:'preview-driver',choferUid:'preview-driver',cashAmount:12000,transferAmount:3000,
  grossAmount:15000,amount:15000,weekStartDate:previousWeek.toISOString().slice(0,10),weekCloseDate:week.weekStartDate,
  reviewStatus:'completed',status:'completed',settlementRuleVersion:'net_wallets_cashbox_10_v1',createdAtMs:Date.now()-86400000,
  sourceReference:'QA historical week — must remain byte-equivalent'};
const legacyPath='uber_weekly_closures/qa-existing-legacy';
const scenarios=[{name:'cash',width:320,cash:10000,digital:0,balance:6000},
  {name:'digital',width:390,cash:0,digital:10000,balance:-4000},
  {name:'mixed',width:768,cash:6000,digital:4000,balance:2000},
  {name:'zero',width:1440,cash:0,digital:0,balance:0},
  {name:'cents',width:390,cash:100.05,digital:0,balance:60.04},
  {name:'cents-digital-017',width:320,cash:100,digital:.17,balance:59.94},
  {name:'cents-digital-195',width:390,cash:100,digital:1.95,balance:59.23}];
const inputFor=sample=>({driverUid:'preview-driver',...week,cashAmount:sample.cash,transferAmount:sample.digital,totalAmount:sample.cash+sample.digital,
  amountBasis:'net_after_uber_commission',cashRecipient:'driver',digitalRecipient:'explora',reconciled:true,sourceReference:`QA Fleet ${sample.name}`});
const money=value=>new Intl.NumberFormat('es-AR',{style:'currency',currency:'ARS',minimumFractionDigits:0,maximumFractionDigits:2}).format(value);
async function copyRecords(from,to){
  const state=await from.api({action:'inspect'});
  await to.api({action:'reset'});
  await to.api({action:'writes',writes:Object.entries(state.records).map(([path,data])=>({target:{path},data}))});
  return state;
}
async function fill(page,sample){
  const amount=value=>String(value).replace('.',',');
  await page.locator('#adminUberNetDriver').selectOption('preview-driver');
  await page.locator('#adminUberNetCash').fill(amount(sample.cash));
  await page.locator('#adminUberNetDigital').fill(amount(sample.digital));
  await page.locator('#adminUberNetTotal').fill(amount(sample.cash+sample.digital));
  await page.locator('#adminUberNetSource').fill(`QA Fleet ${sample.name}`);
  await page.locator('#adminUberNetConfirmed').check();
}
async function open(page){await page.locator('#adminUberLiquidationBtn').click();await page.locator('.admin-uber-net-dialog').waitFor({state:'visible'});}
let browser;
try{
  const admin=await preview('admin'),driver=await preview('driver');
  for(const engine of (process.env.UI_ENGINES||'chromium,webkit').split(',')){
    browser=await (engine==='webkit'?webkit:chromium).launch(engine==='chromium'?{channel:'msedge'}:{});
    for(const sample of scenarios){
      const expectedCashbox=Math.round(((sample.cash+sample.digital)*.10+Number.EPSILON)*100)/100;
      await admin.api({action:'reset'});
      await admin.api({action:'set',target:{path:legacyPath},data:legacy});
      await copyRecords(admin,driver);
      const before=await driver.api({action:'call',name:'getPeriodQuote',input:{}});
      const context=await browser.newContext({viewport:{width:sample.width,height:900},serviceWorkers:'block'});
      let failNext=false;
      await context.route('**/*',async route=>{
        const url=new URL(route.request().url());
        if(![admin.origin,driver.origin].includes(url.origin)){report.blocked.push(url.origin);await route.abort();return;}
        if(url.pathname==='/__preview__/api'&&failNext&&route.request().postDataJSON()?.name==='adminRegisterUberWeeklyClosure'){
          failNext=false;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Fallo local de prueba. Reintentá.',code:'unavailable'})});return;
        }
        await route.continue();
      });
      const page=await context.newPage();page.on('pageerror',e=>report.errors.push(`${engine} ${sample.name}: ${e.message}`));
      await page.goto(admin.origin);await page.locator('#adminDashboard').waitFor({state:'visible'});
      await page.waitForFunction(()=>!document.getElementById('adminQuickStatus')?.textContent.includes('Sincronizando'));
      await open(page);await fill(page,sample);
      const previewAmount=Number((await page.locator('#adminUberNetReview dd').last().innerText()).replace(/[^\d,.]/g,'').replace(/\./g,'').replace(',','.'));
      assert.equal(previewAmount,Math.abs(sample.balance),'Admin preview uses the same rounded settlement');
      if(sample.name==='cash'){
        const stateBefore=await admin.api({action:'inspect'});
        await page.locator('#adminUberNetDigital').fill('-1');
        await page.locator('#adminUberNetSave').click();
        assert.match(await page.locator('#adminUberNetStatus').innerText(),/importes|negativo|concili/i);
        assert.deepEqual(await admin.api({action:'inspect'}),stateBefore,'Negative input must not write');
        await fill(page,sample);failNext=true;await page.locator('#adminUberNetSave').click();
        await page.waitForFunction(()=>document.getElementById('adminUberNetStatus').textContent.includes('Fallo local'));
        assert.deepEqual(await admin.api({action:'inspect'}),stateBefore,'Failed request must not write');
        assert.equal(await page.locator('#adminUberNetSave').isEnabled(),true);
        await page.screenshot({path:path.join(output,`${engine}-admin-${sample.width}-retry.png`)});
      }
      await page.locator('#adminUberNetSave').click();
      await page.waitForFunction(()=>document.getElementById('adminUberNetSave').textContent==='Registrado');
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'Admin page width');
      assert.equal(await page.locator('.admin-uber-net-dialog').evaluate(el=>el.scrollWidth>el.clientWidth),false,'Admin dialog width');
      const dialogBounds=await page.locator('.admin-uber-net-dialog').evaluate(el=>{
        el.scrollTop=0;const box=el.getBoundingClientRect(),top=el.querySelector('header').getBoundingClientRect().top;
        el.scrollTop=el.scrollHeight;const bottom=el.querySelector('footer').getBoundingClientRect().bottom;
        el.scrollTop=0;return {top,bottom,shellTop:box.top,shellBottom:box.bottom};
      });
      assert.ok(dialogBounds.top>=dialogBounds.shellTop-1&&dialogBounds.bottom<=dialogBounds.shellBottom+1,'Both dialog ends remain reachable');
      await page.locator('.admin-uber-net-dialog').screenshot({path:path.join(output,`${engine}-admin-${sample.width}-${sample.name}-top.png`)});
      await page.locator('.admin-uber-net-dialog').evaluate(el=>{el.scrollTop=el.scrollHeight;});
      await page.locator('.admin-uber-net-dialog').screenshot({path:path.join(output,`${engine}-admin-${sample.width}-${sample.name}.png`)});
      const saved=await admin.api({action:'inspect'});
      const entries=Object.entries(saved.records).filter(([p])=>p.startsWith('uber_weekly_closures/'));
      assert.equal(entries.length,2,'One historical week and one new week');
      assert.deepEqual(saved.records[legacyPath],legacy,'Historical week unchanged');
      const [recordPath,record]=entries.find(([p])=>p!==legacyPath);
      assert.equal(record.settlementRuleVersion,'uber_admin_fleet_split_10_v1');
      assert.equal(record.cashAmount,sample.cash);assert.equal(record.transferAmount,sample.digital);
      assert.equal(record.cashboxAmount,expectedCashbox);assert.equal(record.settlementImpact,sample.balance);
      assert.equal(Math.round((record.settlementAfterAdminDecision-record.settlementBeforeAdminDecision)*100),Math.round(sample.balance*100),'Stored balance snapshot agrees with preview');
      await page.locator('#adminUberNetClose').click();await open(page);await fill(page,sample);
      await page.locator('#adminUberNetSave').click();
      await page.waitForFunction(()=>document.getElementById('adminUberNetStatus').textContent.includes('ya quedó registrada'));
      assert.deepEqual((await admin.api({action:'inspect'})).records,saved.records,'Identical retry must not write');
      const conflicting=await admin.api({action:'call',name:'adminRegisterUberWeeklyClosure',input:{...inputFor(sample),sourceReference:'different reference'}},true);
      assert.equal(conflicting.ok,false);assert.equal(conflicting.data.code,'already-exists');
      const negative=await admin.api({action:'call',name:'adminRegisterUberWeeklyClosure',input:{...inputFor(sample),transferAmount:-1,totalAmount:sample.cash-1}},true);
      assert.equal(negative.ok,false);assert.equal(negative.data.code,'invalid-argument');
      await copyRecords(admin,driver);
      const after=await driver.api({action:'call',name:'getPeriodQuote',input:{}});
      assert.equal(Math.round((after.balance-before.balance)*100),Math.round(sample.balance*100),`Quote movement ${after.balance-before.balance} != ${sample.balance}`);
      assert.equal(after.presentation.uber.cash,sample.cash);assert.equal(after.presentation.uber.digital,sample.digital);
      assert.equal(after.presentation.uber.unavailableCount,1,'Legacy split must not be invented');
      assert.equal(Math.round((after.presentation.uber.cashbox-before.presentation.uber.cashbox)*100),Math.round(expectedCashbox*100));
      assert.equal(Math.round((after.presentation.uber.total-before.presentation.uber.total)*100),Math.round((sample.cash+sample.digital)*100));
      const driverBefore=await driver.api({action:'inspect'});
      const unauthorized=await driver.api({action:'call',name:'adminRegisterUberWeeklyClosure',input:inputFor(sample)},true);
      assert.equal(unauthorized.ok,false);assert.equal(unauthorized.data.code,'permission-denied');
      assert.deepEqual(await driver.api({action:'inspect'}),driverBefore,'Driver cannot register a week');
      await page.goto(driver.origin);await page.locator('#app').waitFor({state:'visible'});
      assert.equal(await page.locator('#adminUberLiquidationBtn').isVisible(),false);
      await page.locator('[data-driver-nav="wallet"]').click();await page.locator('.period-section.uber').waitFor({state:'visible'});
      const card=page.locator('.period-section.uber');
      assert.equal(await page.locator('#confirmPeriodClose').count(),1,'One final settlement action');
      assert.equal(await card.evaluate(el=>el.previousElementSibling?.classList.contains('digital')),true,'Uber directly follows Digital');
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'Driver page width');
      assert.equal(await card.evaluate(el=>el.scrollWidth>el.clientWidth),false,'Uber card width');
      assert.ok((await card.innerText()).includes(money(sample.cash)));
      assert.ok((await card.innerText()).includes(money(sample.digital)));
      assert.ok((await card.innerText()).includes(money(Math.abs(after.presentation.uber.balance))),'Wallet preserves displayed settlement cents');
      await card.evaluate(el=>el.scrollIntoView({block:'center',behavior:'instant'}));
      const cardBounds=await card.evaluate(el=>{
        const box=el.getBoundingClientRect(),nav=document.querySelector('.explora-nav').getBoundingClientRect();
        return {top:box.top,bottom:box.bottom,navTop:nav.top,height:innerHeight};
      });
      assert.ok(cardBounds.top>=0&&cardBounds.bottom<=Math.min(cardBounds.height,cardBounds.navTop)+1,'Entire Uber card can be read above navigation');
      await card.screenshot({path:path.join(output,`${engine}-driver-${sample.width}-${sample.name}.png`)});
      report.cases.push({engine,...sample,previewAmount,recordPath,dialogBounds,cardBounds,beforeBalance:before.balance,afterBalance:after.balance,presentation:after.presentation.uber});
      console.log(`${engine} ${sample.width} ${sample.name}: UI, quote, retry, errors, driver permissions and legacy preservation PASS`);
      await context.close();
    }
    await browser.close();browser=null;
  }
  assert.deepEqual(report.errors,[]);assert.deepEqual(report.blocked,[]);
}finally{
  await browser?.close();
  await Promise.all(endpoints.map(({server})=>new Promise(resolve=>server.close(resolve))));
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
  assert.equal(path.dirname(runtime),path.resolve(os.tmpdir()));
  for(const role of ['admin','driver'])fs.rmSync(path.join(runtime,role+'.json'),{force:true});
  fs.rmdirSync(runtime);
}
console.log(`Saved ${report.cases.length} complete cases to ${output}`);
