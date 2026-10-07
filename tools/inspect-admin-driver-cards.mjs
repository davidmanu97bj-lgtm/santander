// Offline UI regression against the real entry point and the in-memory preview.
// All non-preview browser traffic is blocked. No credentials or production writes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {chromium, webkit} from 'playwright';
import {ROOT} from './project.mjs';

const output = path.resolve(process.env.ADMIN_CARDS_QA_OUTPUT || path.join(ROOT, '../qa-admin-driver-cards'));
fs.mkdirSync(output, {recursive:true});
const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'explora-admin-cards-'));
process.env.PREVIEW_ROLE = 'admin';
process.env.PREVIEW_STATE_PATH = path.join(runtime, 'state.json');
const {server} = await import('./preview.mjs');
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const report = {cases:[], errors:[], blocked:[], origin, stateFile:process.env.PREVIEW_STATE_PATH};
const selectedUid = 'preview-driver', otherUid = 'preview-nicolas';
const card = uid => `.admin-driver-card[data-admin-driver="${uid}"]`;
const action = (uid, name) => `${card(uid)} [data-admin-driver-action="${name}"]`;
const expectedActions = ['movements','closures','receipts','accountant','invoices','digital','debt'];
const now = Date.now();

async function api(body) {
  const response = await fetch(origin + '/__preview__/api', {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)
  });
  const result = await response.json();
  assert.ok(response.ok, JSON.stringify(result));
  return result;
}
async function seed() {
  await api({action:'reset'});
  for (const [id, uid, detail] of [['qa-javier',selectedUid,'QA SOLO JAVIER'],['qa-nicolas',otherUid,'QA SOLO NICOLAS']]) {
    await api({action:'set',target:{path:'billing_records/'+id},data:{
      driverUid:uid,uid,driverName:uid===selectedUid?'Javier de prueba':'Nicolás de prueba',
      amount:12345,method:'cash',type:'billing',status:'completed',detail,
      proofUrl:origin+'/__preview__/proof.svg',createdAtMs:now-60000,
      settlementRuleVersion:'net_wallets_cashbox_10_v1'
    }});
    await api({action:'set',target:{path:'arca_invoices/'+id},data:{
      driverUid:uid,description:detail,status:'queued',invoiceType:6,
      detail:{ImpTotal:12345},createdAtMs:now-60000,
      issuer:{legalName:'EXPLORA DE PRUEBA',pointOfSale:3,cuit:'20000000001'},environment:'homologation'
    }});
    await api({action:'set',target:{path:'cierres_semanales/'+id},data:{
      driverUid:uid,operatorUid:uid,operatorName:uid===selectedUid?'Javier de prueba':'Nicolás de prueba',
      type:'closure',status:'completed',direction:'driver_pays_explora',
      settlementAmount:100,paidAmountTotal:100,remainingAmount:0,createdAtMs:now-86400000,
      sourceReference:detail
    }});
  }
}
async function ready(page) {
  await page.locator('#adminDashboard').waitFor({state:'visible'});
  await page.locator(card(selectedUid)).waitFor({state:'visible'});
  await page.waitForFunction(() => !document.getElementById('adminQuickStatus')?.textContent.includes('Sincronizando'));
}
async function overview(page) {
  if (await page.locator('#adminBackToDrivers').isVisible()) await page.locator('#adminBackToDrivers').click();
  await page.locator(card(selectedUid)).waitFor({state:'visible'});
}
async function closeModal(page, id) {
  const button = page.locator(`#${id} [data-close="${id}"]`).first();
  await button.click();
  await page.locator('#'+id).waitFor({state:'hidden'});
}
async function assertNoOverflow(page, label) {
  const bounds = await page.evaluate(() => ({
    width:innerWidth,scroll:document.documentElement.scrollWidth,
    rows:[...document.querySelectorAll('#adminDriverList .admin-driver-card')].map(node => {
      const box=node.getBoundingClientRect();return {left:box.left,right:box.right,width:box.width};
    })
  }));
  assert.ok(bounds.scroll <= bounds.width+1, `${label}: document overflow ${JSON.stringify(bounds)}`);
  for (const row of bounds.rows) assert.ok(row.left>=-1 && row.right<=bounds.width+1, `${label}: driver row overflow`);
  return bounds;
}
function assertWaiver(record) {
  assert.equal(record.receiptStatus,'waived_by_admin');
  assert.equal(record.receiptRequired,false);
  assert.equal(record.receiptWaived,true);
  assert.equal(record.receiptWaivedByUid,'preview-admin');
  assert.equal(record.receiptWaivedByRole,'admin');
  assert.ok(Number(record.receiptWaivedAtMs)>0);
  assert.ok(record.receiptWaivedAt);
  for(const key of ['proofUrl','proofPath','receiptUrl','receiptPath']) assert.ok(!record[key], key+' must be empty');
}
async function waitForRecord(predicate, message) {
  for(let attempt=0;attempt<60;attempt++) {
    const state=await api({action:'inspect'});
    const entry=Object.entries(state.records).find(([recordPath,record])=>predicate(recordPath,record));
    if(entry)return entry;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw new Error(message);
}
async function exerciseNoReceipt(page) {
  const before=await api({action:'inspect'});
  const originalOther=Object.fromEntries(Object.entries(before.records).filter(([,r])=>r.driverUid===otherUid));
  await page.locator(action(selectedUid,'digital')).click();
  await page.locator('#adminExpenseAmount').fill('1000');
  await page.locator('#adminExpenseDetail').fill('QA PAGO DIGITAL SIN COMPROBANTE');
  await page.locator('#adminExpenseType').selectOption('combustible');
  await page.locator('#adminExpenseNoReceipt').check();
  assert.equal(await page.locator('#adminExpenseProof').getAttribute('required'),null);
  await page.locator('#saveAdminDigitalExpense').click();
  const [,expense]=await waitForRecord((p,r)=>p.startsWith('gastos/')&&r.detail==='QA PAGO DIGITAL SIN COMPROBANTE','Digital payment was not saved');
  assertWaiver(expense);assert.equal(expense.driverUid,selectedUid);assert.equal(expense.amount,1000);
  assert.equal(expense.billingImpactAmount,500,'Existing shared expense policy is preserved');
  await page.locator('#adminDigitalExpenseModal').waitFor({state:'hidden'});

  await page.locator(action(selectedUid,'closures')).click();
  await page.locator('#adminAdjustmentBtn').click();
  await page.locator('#adjustmentAmount').fill('500');
  await page.locator('#adjustmentDetail').fill('QA ACHIQUE SIN COMPROBANTE');
  await page.locator('#adjustmentType').selectOption('driver_to_explora');
  await page.locator('#adjustmentNoReceipt').check();
  await page.locator('#saveAdminAdjustmentBtn').click();
  const [,adjustment]=await waitForRecord((p,r)=>p.startsWith('billing_records/')&&r.detail==='QA ACHIQUE SIN COMPROBANTE','Partial payment was not saved');
  assertWaiver(adjustment);assert.equal(adjustment.driverUid,selectedUid);assert.equal(adjustment.amount,500);
  assert.equal(adjustment.type,'settlement_adjustment');assert.equal(adjustment.adjustmentDirection,'driver_to_explora');
  await page.locator('#adminAdjustmentModal').waitFor({state:'hidden'});

  // This requested closure is local only, and does not trigger a startup review popup.
  await page.evaluate(async () => {
    const firebase=await import('/__preview__/firebase.js');
    await firebase.setDoc(firebase.doc({},'cierres_semanales','qa-pay-selected'),{
      driverUid:'preview-driver',operatorUid:'preview-driver',operatorName:'Javier de prueba',
      status:'requested',direction:'explora_pays_driver',settlementAmount:1000,requestedAmount:1000,
      paidAmountTotal:0,remainingAmount:1000,createdAtMs:Date.now(),recipientAlias:'prueba.local',recipientCuit:'20000000001'
    });
    await firebase.setDoc(firebase.doc({},'cierres_semanales','qa-pay-other'),{
      driverUid:'preview-nicolas',operatorUid:'preview-nicolas',operatorName:'Nicolás de prueba',
      status:'requested',direction:'explora_pays_driver',settlementAmount:2000,requestedAmount:2000,
      paidAmountTotal:0,remainingAmount:2000,createdAtMs:Date.now(),recipientAlias:'otro.local',recipientCuit:'20000000002'
    });
  });
  await page.locator('#adminManageClosuresBtn').click();
  await page.locator('[data-admin-closure="qa-pay-selected"]').waitFor({state:'visible'});
  assert.equal(await page.locator('[data-admin-closure="qa-pay-other"]').count(),0,'Only selected driver closure can be opened');
  await page.locator('[data-admin-closure="qa-pay-selected"]').click();
  await page.locator('#adminCloseNoReceipt').check();
  await page.locator('#confirmAdminPayment').click();
  const [,closure]=await waitForRecord((p,r)=>p==='cierres_semanales/qa-pay-selected'&&r.status==='completed','No-receipt closure not completed');
  assertWaiver(closure);assert.equal(closure.paidAmountTotal,1000);assert.equal(closure.remainingAmount,0);
  const state=await api({action:'inspect'});
  const paired=Object.values(state.records).filter(r=>r.closureId==='qa-pay-selected');
  assert.equal(paired.length,1,'One financial settlement entry per closure');
  assertWaiver(paired[0]);assert.equal(paired[0].type,'settlement_adjustment');
  assert.equal(state.records['cierres_semanales/qa-pay-other'].paidAmountTotal,0);
  for(const [recordPath,record] of Object.entries(originalOther)) assert.deepEqual(state.records[recordPath],record,'Other driver record was changed');
  assert.deepEqual(Object.keys(state.records).filter(p=>p.startsWith('arca_invoices/')).sort(),Object.keys(before.records).filter(p=>p.startsWith('arca_invoices/')).sort(),'No invoice created by a settlement');
  assert.equal(state.uploads.length,0,'No fabricated receipt uploads');
  await closeModal(page,'closeModal');await overview(page);
  return {digital:true,partialPayment:true,closure:true,otherDriverUntouched:true};
}

let browser;
try {
  for (const engine of (process.env.UI_ENGINES || 'chromium,webkit').split(',')) {
    browser = await (engine==='webkit'?webkit:chromium).launch(engine==='chromium'?{channel:'msedge'}:{});
    for (const viewport of [{width:1440,height:1000},{width:390,height:844},{width:360,height:800}]) {
      await seed();
      const context=await browser.newContext({viewport,serviceWorkers:'block'});
      const requests=[];
      await context.route('**/*',async route => {
        const url=new URL(route.request().url());
        if(url.origin!==origin){report.blocked.push(url.origin);await route.abort();return;}
        if(url.pathname==='/__preview__/api' && route.request().method()==='POST') requests.push(route.request().postDataJSON());
        await route.continue();
      });
      const page=await context.newPage();
      page.on('pageerror',error=>report.errors.push(`${engine} ${viewport.width}: ${error.message}`));
      await page.goto(origin);await ready(page);
      for(const id of ['adminOperationsBtn','adminDriversBtn','adminGroupDebtBtn']) assert.ok(await page.locator('#'+id).isVisible(),id+' visible');
      assert.equal(await page.locator('[data-admin-panel="operations"]').isVisible(),false,'Operations starts hidden');
      assert.equal(await page.locator('#opsSalidasBoard').isVisible(),false,'Airport control is hidden initially');
      assert.equal(await page.locator('#adminDriverList .admin-driver-card').count(),3);
      for(const uid of [selectedUid,'preview-marcelo',otherUid]) {
        assert.deepEqual(await page.locator(card(uid)+' [data-admin-driver-action]').evaluateAll(nodes=>nodes.map(n=>n.dataset.adminDriverAction)),expectedActions);
        for(const name of expectedActions) assert.ok(await page.locator(action(uid,name)).isVisible(),`${uid}/${name} visible`);
      }
      const bounds=await assertNoOverflow(page,`${engine} ${viewport.width}`);
      await page.screenshot({path:path.join(output,`${engine}-${viewport.width}-overview.png`),fullPage:true});

      // The selected driver is enforced by UID, including read-only tax/document queries.
      await page.locator(action(selectedUid,'movements')).click();
      await page.locator('#adminActivityTable td').filter({hasText:'QA SOLO JAVIER'}).waitFor();
      assert.ok(!(await page.locator('#adminActivityTable').innerText()).includes('QA SOLO NICOLAS'));
      await page.locator('#adminMovementsBtn').click();
      assert.equal(await page.locator('#movementDriver').inputValue(),selectedUid);
      assert.ok(await page.locator('#movementDriver').isDisabled(),'Corrections lock the row driver');
      await closeModal(page,'adminMovementsModal');await overview(page);

      await page.locator(action(selectedUid,'receipts')).click();
      await page.locator('#adminReceiptsTable td').filter({hasText:'QA SOLO JAVIER'}).waitFor();
      assert.ok(!(await page.locator('#adminReceiptsTable').innerText()).includes('QA SOLO NICOLAS'));
      await overview(page);

      await page.locator(action(selectedUid,'closures')).click();
      assert.ok(!(await page.locator('#adminClosuresTable').innerText()).includes('Nicolás de prueba'));
      await page.locator('#adminAdjustmentBtn').click();
      assert.equal(await page.locator('#adjustmentDriver').inputValue(),selectedUid);
      assert.ok(await page.locator('#adjustmentDriver').isDisabled());
      assert.ok(await page.locator('#adminAdjustmentModal').getByLabel('Sin comprobante',{exact:false}).isVisible());
      await closeModal(page,'adminAdjustmentModal');await overview(page);

      await page.locator(action(selectedUid,'accountant')).click();
      await page.locator('#adminDocumentsTable').getByText('Javier de prueba',{exact:true}).waitFor();
      assert.ok(!(await page.locator('#adminDocumentsTable').innerText()).includes('Nicolás de prueba'));
      assert.ok(requests.some(r=>r.name==='adminMonthlyDocuments'&&r.input?.driverUid===selectedUid&&r.input?.overviewOnly===true),'Server document overview requests selected driver');
      await overview(page);

      await page.locator(action(selectedUid,'invoices')).click();
      await page.locator('#invoicesList').getByText('QA SOLO JAVIER',{exact:true}).first().waitFor();
      assert.ok(!(await page.locator('#invoicesList').innerText()).includes('QA SOLO NICOLAS'));
      assert.ok(requests.some(r=>r.action==='list'&&r.target?.path==='arca_invoices'&&r.target.conditions?.some(c=>c.type==='where'&&c.field==='driverUid'&&c.value===selectedUid)),'Invoice query is UID-scoped before limit');
      await closeModal(page,'invoicesModal');

      for(const [name,modal,select] of [['digital','adminDigitalExpenseModal','adminExpenseDriver'],['debt','debtModal','debtDriver']]) {
        await page.locator(action(selectedUid,name)).click();
        assert.equal(await page.locator('#'+select).inputValue(),selectedUid);
        assert.ok(await page.locator('#'+select).isDisabled(),name+' locks driver');
        if(name==='digital') assert.ok(await page.locator('#'+modal).getByLabel('Sin comprobante',{exact:false}).isVisible());
        await closeModal(page,modal);
      }
      // Background snapshots must not replace the focused action with a fresh node.
      const focused=page.locator(action(selectedUid,'digital'));
      await focused.focus();
      await page.evaluate(async () => {
        const firebase=await import('/__preview__/firebase.js');
        await firebase.setDoc(firebase.doc({},'billing_records','qa-background'),{
          driverUid:'preview-nicolas',uid:'preview-nicolas',amount:25,method:'cash',type:'billing',status:'completed',detail:'QA background',createdAtMs:Date.now()
        });
      });
      await page.waitForTimeout(350);
      assert.ok(await focused.evaluate(node=>document.activeElement===node),'Snapshot update keeps focused driver action');
      await page.locator('#adminOperationsBtn').click();
      await page.locator('#opsSalidasBoard').waitFor({state:'visible'});
      assert.equal(await page.locator('#opsSalidasBoard').count(),1,'One persistent Operations board');
      await overview(page);
      await assertNoOverflow(page,`${engine} ${viewport.width} after navigation`);
      const noReceipt=viewport.width===1440?await exerciseNoReceipt(page):null;
      report.cases.push({engine,...viewport,actions:expectedActions,uidScope:true,focusPreserved:true,bounds,noReceipt});
      await context.close();
    }
    await browser.close();browser=null;
  }
  assert.deepEqual(report.errors,[],'No unhandled browser errors');
  console.log(JSON.stringify({ok:true,cases:report.cases.length,output},null,2));
} finally {
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
  await browser?.close();
  await new Promise(resolve=>server.close(resolve));
}
