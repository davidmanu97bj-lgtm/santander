// Real entry point, local in-memory Firebase adapter, no production connections.
// Run with Node 22; Edge/Chromium and WebKit cover desktop and both mobile widths.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {chromium, webkit} from 'playwright';
import {ROOT} from './project.mjs';

const output=path.resolve(process.env.ADMIN_MONTHLY_QA_OUTPUT||path.join(ROOT,'../../outputs/admin-monthly-20261007'));
fs.mkdirSync(output,{recursive:true});
const runtime=fs.mkdtempSync(path.join(os.tmpdir(),'explora-admin-monthly-'));
process.env.PREVIEW_ROLE='admin';
process.env.PREVIEW_STATE_PATH=path.join(runtime,'state.json');
const {server}=await import('./preview.mjs');
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const report={ok:false,origin,stateFile:process.env.PREVIEW_STATE_PATH,localOnly:true,cases:[],errors:[],blocked:[]};
const selectedUid='preview-driver',otherUid='preview-nicolas';
const fixedTime=new Date('2026-10-07T15:00:00.000Z');
const currentMonth='2026-10',previousMonth='2026-09',nextMonth='2026-11';
const card=uid=>`.admin-driver-card[data-admin-driver="${uid}"]`;
const digital=uid=>`${card(uid)} [data-admin-driver-action="digital"]`;
const monthlyStatus=concept=>`#adminExpenseMonthlyStatus [data-monthly-concept="${concept}"]`;
const details={canon:'QA CANON COMPARTIDO OCTUBRE',patente:'QA PATENTE 100 CHOFER OCTUBRE'};

async function api(body){
  const response=await fetch(origin+'/__preview__/api',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const result=await response.json();assert.ok(response.ok,JSON.stringify(result));return result;
}
async function seed(){
  await api({action:'reset'});
  // A canonical past-month payment must not dismiss the current month reminder.
  for(const concept of ['canon','patente'])await api({action:'set',target:{path:'gastos/qa-prior-'+concept},data:{
    driverUid:selectedUid,uid:selectedUid,expenseType:concept,category:concept,amount:1000,
    detail:'QA MES ANTERIOR '+concept,expenseMonth:previousMonth,monthlyConcept:concept,
    expensePaymentMethod:'digital',payerRole:'explora',registeredByAdmin:true,status:'active',
    createdAtMs:Date.parse('2026-09-07T15:00:00Z'),billingImpactAmount:500,
    receiptFlowVersion:'gross_expense_policy_v3',settlementRuleVersion:'net_wallets_cashbox_10_v1'
  }});
}
async function ready(page){
  await page.locator('#adminDashboard').waitFor({state:'visible'});
  await page.locator(card(selectedUid)).waitFor({state:'visible'});
  await page.waitForFunction(()=>!document.getElementById('adminQuickStatus')?.textContent.includes('Sincronizando'));
}
async function missing(page,uid,concepts){
  const button=page.locator(digital(uid));
  const expected=concepts.length?'Falta: '+concepts.map(c=>c==='canon'?'Canon':'Patente').join(' + '):'Canon y patente cargados';
  await page.waitForFunction(({selector,expected})=>document.querySelector(selector)?.textContent.includes(expected),{selector:digital(uid),expected});
  const className=await button.getAttribute('class');
  assert.equal(className.includes('monthly-missing'),Boolean(concepts.length),uid+' reminder color');
  assert.equal(await button.locator('.admin-monthly-note').innerText(),expected);
  if(concepts.length){
    const border=await button.evaluate(el=>getComputedStyle(el).borderTopColor);
    assert.equal(border,'rgb(205, 64, 58)','The pending payment has the red warning border');
  }
}
async function noOverflow(page,label){
  const dimensions=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,
    rows:[...document.querySelectorAll('#adminDriverList .admin-driver-card')].map(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right};}),
    modal:[...document.querySelectorAll('#adminDigitalExpenseModal:not(.hidden) .modal-card')].map(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,scroll:el.scrollWidth,width:el.clientWidth};})}));
  assert.ok(dimensions.scroll<=dimensions.width+1,label+': page width '+JSON.stringify(dimensions));
  for(const row of [...dimensions.rows,...dimensions.modal])assert.ok(row.left>=-1&&row.right<=dimensions.width+1,label+': element overflows viewport');
  for(const modal of dimensions.modal)assert.ok(modal.scroll<=modal.width+1,label+': modal content overflows');
  return dimensions;
}
async function waitForRecord(detail){
  for(let attempt=0;attempt<80;attempt++){
    const state=await api({action:'inspect'});
    const entries=Object.entries(state.records).filter(([p,r])=>p.startsWith('gastos/')&&r.detail===detail);
    if(entries.length){assert.equal(entries.length,1,'Exactly one expense for '+detail);return entries[0];}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw new Error('No local expense was saved: '+detail);
}
function verifyWaiver(record){
  assert.equal(record.receiptStatus,'waived_by_admin');assert.equal(record.receiptWaived,true);
  assert.equal(record.receiptRequired,false);assert.equal(record.receiptWaivedByUid,'preview-admin');
  assert.equal(record.receiptWaivedByRole,'admin');assert.ok(record.receiptWaivedAtMs>0);assert.ok(record.receiptWaivedAt);
  for(const key of ['proofUrl','proofPath','receiptUrl','receiptPath'])assert.ok(!record[key],key+' absent');
}
function verifyExpense(record,{concept,type,amount,debit}){
  assert.equal(record.expenseMonth,currentMonth);assert.equal(record.monthlyConcept,concept);
  assert.equal(record.monthlyChargeVersion,1);assert.equal(record.amount,amount);
  for(const key of ['expenseType','category','tipo'])assert.equal(record[key],type,key+' is canonical');
  for(const key of ['driverUid','uid','choferUid','ownerUid','driverId','operatorUid'])assert.equal(record[key],selectedUid,key+' is scoped');
  assert.equal(record.billingImpactAmount,debit);assert.equal(record.expensePaymentMethod,'digital');
  assert.equal(record.payerRole,'explora');verifyWaiver(record);
}
async function openMonthly(page,concept){
  await page.locator(digital(selectedUid)).click();
  assert.equal(await page.locator('#adminExpenseDriver').inputValue(),selectedUid);
  assert.ok(await page.locator('#adminExpenseDriver').isDisabled(),'Card driver is locked');
  assert.equal(await page.locator('#adminExpenseType').inputValue(),concept,'First missing concept opens by default');
  assert.equal(await page.locator('#adminExpenseMonth').inputValue(),currentMonth,'Month defaults to current Argentina month');
  assert.ok(await page.locator('#adminExpenseMonthlyFields').isVisible());
}
async function fillMonthly(page,{concept,split,amount,detail}){
  await page.locator('#adminExpenseType').selectOption(concept);
  await page.locator('#adminExpenseSplit').selectOption(split);
  await page.locator('#adminExpenseAmount').fill(String(amount));
  await page.locator('#adminExpenseDetail').fill(detail);
  await page.locator('#adminExpenseNoReceipt').check();
  assert.equal(await page.locator('#adminExpenseProof').evaluate(el=>el.required),false);
}
async function closeModal(page){
  await page.locator('#adminDigitalExpenseModal [data-close="adminDigitalExpenseModal"]').first().click();
  await page.locator('#adminDigitalExpenseModal').waitFor({state:'hidden'});
}
async function duplicateAttempt(page,{legacy=false}={}){
  const before=await api({action:'inspect'});
  await page.locator(digital(selectedUid)).click();
  await fillMonthly(page,{concept:'canon',split:'shared',amount:100000,detail:legacy?'QA DUPLICATE LEGACY':'QA DUPLICATE CANON'});
  await page.locator('#saveAdminDigitalExpense').click();
  await page.waitForFunction(()=>document.getElementById('adminDigitalExpenseStatus')?.textContent.includes('ya está cargado'));
  assert.match(await page.locator('#adminDigitalExpenseStatus').innerText(),/no se duplicó la deuda/);
  assert.deepEqual(await api({action:'inspect'}),before,'Duplicate submission writes no record and uploads no file');
  await closeModal(page);
}

let browser,context,page,activeCase;
try{
  for(const engine of (process.env.UI_ENGINES||'chromium,webkit').split(',')){
    browser=await (engine==='webkit'?webkit:chromium).launch(engine==='chromium'?{channel:'msedge'}:{});
    const widths=(process.env.UI_WIDTHS||'1440,390,360').split(',').map(Number);
    for(const width of widths){
      const viewport={width,height:width===1440?1000:width===390?844:800};
      activeCase={engine,...viewport,steps:[]};report.cases.push(activeCase);
      await seed();
      context=await browser.newContext({viewport,serviceWorkers:'block',timezoneId:'America/Argentina/Buenos_Aires'});
      await context.route('**/*',async route=>{
        const url=new URL(route.request().url());
        if(url.origin!==origin){report.blocked.push(url.origin);await route.abort();return;}
        await route.continue();
      });
      page=await context.newPage();page.setDefaultTimeout(15000);
      page.on('pageerror',error=>report.errors.push(`${engine} ${width}: ${error.message}`));
      await page.clock.install({time:fixedTime});
      await page.goto(origin);await ready(page);
      for(const uid of [selectedUid,'preview-marcelo',otherUid])await missing(page,uid,['canon','patente']);
      activeCase.bounds=await noOverflow(page,'Initial overview');
      activeCase.steps.push('All drivers show both pending; previous-month canonical records do not clear current reminders');
      await page.screenshot({path:path.join(output,`${engine}-${width}-01-pending.png`),fullPage:true});
      const before=await api({action:'inspect'});

      await openMonthly(page,'canon');
      assert.match(await page.locator(monthlyStatus('canon')).innerText(),/Falta cargar/);
      assert.match(await page.locator(monthlyStatus('patente')).innerText(),/Falta cargar/);
      await fillMonthly(page,{concept:'canon',split:'shared',amount:100000,detail:details.canon});
      assert.match(await page.locator('#adminExpenseResponsibility').innerText(),/50% a cargo del chofer/);
      await noOverflow(page,'Canon form');
      await page.screenshot({path:path.join(output,`${engine}-${width}-02-canon-form.png`),fullPage:true});
      await page.locator('#saveAdminDigitalExpense').click();
      const [canonPath,canon]=await waitForRecord(details.canon);
      verifyExpense(canon,{concept:'canon',type:'canon_compartido',amount:100000,debit:50000});
      await page.locator('#adminDigitalExpenseModal').waitFor({state:'hidden'});
      await missing(page,selectedUid,['patente']);await missing(page,otherUid,['canon','patente']);
      activeCase.steps.push('Canon shared 50/50 saves canonical expense and $50,000 driver debit; only patente remains pending');
      await page.reload();await ready(page);await missing(page,selectedUid,['patente']);
      await page.screenshot({path:path.join(output,`${engine}-${width}-03-patente-pending.png`),fullPage:true});
      activeCase.steps.push('Reload retains canon completion and patente reminder');

      await openMonthly(page,'patente');
      assert.match(await page.locator(monthlyStatus('canon')).innerText(),/Cargado/);
      assert.match(await page.locator(monthlyStatus('patente')).innerText(),/Falta cargar/);
      await fillMonthly(page,{concept:'patente',split:'driver',amount:20000,detail:details.patente});
      assert.match(await page.locator('#adminExpenseResponsibility').innerText(),/100% a cargo del chofer/);
      await page.locator('#saveAdminDigitalExpense').click();
      const [patentePath,patente]=await waitForRecord(details.patente);
      verifyExpense(patente,{concept:'patente',type:'patente_chofer',amount:20000,debit:20000});
      assert.equal(patente.driverDebtAmount,20000);
      await page.locator('#adminDigitalExpenseModal').waitFor({state:'hidden'});
      await missing(page,selectedUid,[]);await missing(page,otherUid,['canon','patente']);
      const after=await api({action:'inspect'});
      for(const [p,r] of Object.entries(before.records))assert.deepEqual(after.records[p],r,'Existing record remains intact: '+p);
      const newPaths=Object.keys(after.records).filter(p=>!Object.hasOwn(before.records,p));
      assert.deepEqual(newPaths.filter(p=>!p.startsWith('admin_audit/')).sort(),[canonPath,patentePath].sort(),'Only the selected driver receives financial records');
      assert.equal(newPaths.filter(p=>p.startsWith('admin_audit/')).length,2,'One monthly uniqueness guard per concept');
      assert.equal(after.uploads.length,0,'No fabricated file uploads');
      activeCase.steps.push('Patente 100% saves $20,000 driver debit; red warning clears; other drivers and existing financial records are unchanged');
      await page.screenshot({path:path.join(output,`${engine}-${width}-04-complete.png`),fullPage:true});
      await duplicateAttempt(page);activeCase.steps.push('Duplicate current-month canon is refused without new writes');

      // Exercise pre-migration records with no canonical expenseMonth field.
      await seed();
      await api({action:'set',target:{path:'gastos/qa-legacy-canon'},data:{driverUid:selectedUid,uid:selectedUid,
        expenseType:'canon',expensePaymentMethod:'digital',payerRole:'explora',status:'active',
        amount:1000,detail:'QA LEGACY DIGITAL CANON',createdAtMs:fixedTime.getTime()-86400000}});
      await page.reload();await ready(page);await missing(page,selectedUid,['patente']);
      await duplicateAttempt(page,{legacy:true});
      await api({action:'set',target:{path:'gastos/qa-legacy-patente'},data:{driverUid:selectedUid,uid:selectedUid,
        tipo:'patente',expensePaymentMethod:'digital',payerRole:'explora',status:'active',
        amount:1000,detail:'QA LEGACY DIGITAL PATENTE',createdAt:{seconds:Math.floor(fixedTime.getTime()/1000),nanoseconds:0}}});
      await page.reload();await ready(page);await missing(page,selectedUid,[]);
      activeCase.steps.push('Legacy current-month canon/patente digital expenses are recognized via timestamps and block a duplicate');

      // Advance an installed browser clock across Argentina midnight. The live
      // 30-second reminder refresh fires once; no wall-clock month wait or reload.
      const beforeRollover=await api({action:'inspect'});
      await page.clock.setSystemTime(new Date('2026-11-01T02:59:50.000Z'));
      await page.clock.fastForward(45000);
      await missing(page,selectedUid,['canon','patente']);
      await page.locator(digital(selectedUid)).click();
      assert.equal(await page.locator('#adminExpenseMonth').inputValue(),nextMonth);
      assert.equal(await page.locator('#adminExpenseType').inputValue(),'canon');
      assert.match(await page.locator(monthlyStatus('canon')).innerText(),/Falta cargar/);
      assert.match(await page.locator(monthlyStatus('patente')).innerText(),/Falta cargar/);
      await closeModal(page);
      assert.deepEqual(await api({action:'inspect'}),beforeRollover,'Rollover reminders do not manufacture charges');
      await page.reload();await ready(page);await missing(page,selectedUid,['canon','patente']);
      await noOverflow(page,'Rollover overview');
      await page.screenshot({path:path.join(output,`${engine}-${width}-05-november-pending.png`),fullPage:true});
      activeCase.steps.push('Argentina next-month rollover restores both reminders live and after reload; no automatic financial writes');
      activeCase.ok=true;
      await context.close();context=null;page=null;
    }
    await browser.close();browser=null;
  }
  assert.deepEqual(report.errors,[],'No unhandled browser errors');
  report.ok=true;
  console.log(JSON.stringify({ok:true,cases:report.cases.length,output},null,2));
}catch(error){
  report.failure=error.stack||String(error);if(activeCase)activeCase.ok=false;
  if(page)await page.screenshot({path:path.join(output,`${activeCase.engine}-${activeCase.width}-failure.png`),fullPage:true}).catch(()=>{});
  throw error;
}finally{
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
  await context?.close();await browser?.close();
  await new Promise(resolve=>server.close(resolve));
}
