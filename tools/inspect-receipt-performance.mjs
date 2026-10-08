// Offline browser QA: real image decoding/canvas and app forms, local Firebase only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {chromium,webkit} from 'playwright';
import {ROOT} from './project.mjs';

const output=path.resolve(process.env.RECEIPT_QA_OUTPUT||path.join(ROOT,'../../outputs/fluidez-20261007'));
fs.mkdirSync(output,{recursive:true});
const runtime=fs.mkdtempSync(path.join(os.tmpdir(),'explora-receipt-qa-'));
process.env.PREVIEW_ROLE='driver';process.env.PREVIEW_STATE_PATH=path.join(runtime,'state.json');
const {server}=await import('./preview.mjs');
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const report={ok:false,localOnly:true,origin,cases:[],blocked:[],errors:[],note:'Canvas and form timings are local QA, not production network benchmarks.'};
async function api(body){const r=await fetch(origin+'/__preview__/api',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const json=await r.json();assert.ok(r.ok,JSON.stringify(json));return json;}
async function imageFixture(page){
  return page.evaluate(async()=>{
    const canvas=document.createElement('canvas');canvas.width=2400;canvas.height=3200;
    const ctx=canvas.getContext('2d'),pixels=ctx.createImageData(2400,3200);
    let seed=571;
    for(let i=0;i<pixels.data.length;i+=4){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const v=185+(seed>>>24)%70;pixels.data[i]=v;pixels.data[i+1]=v;pixels.data[i+2]=v;pixels.data[i+3]=255;}
    ctx.putImageData(pixels,0,0);ctx.fillStyle='#fff';ctx.fillRect(200,200,2000,2800);
    ctx.fillStyle='#14253b';ctx.font='bold 95px sans-serif';ctx.fillText('COMPROBANTE DE PRUEBA',280,400);
    ctx.font='65px sans-serif';
    for(const [text,y] of [['SOLO QA LOCAL - SIN VALOR FISCAL',550],['EXPLORA - Cobro digital',730],['Fecha: 07/10/2026',900],['Importe: $ 125.000,00',1120],['Operacion: QA-20261007-001',1300],['Origen: Aeropuerto Iguazu',1490],['Destino: Terminal Iguazu',1660],['Referencia: TRANSFERENCIA TEST',1840],['Estado: APROBADO (SIMULADO)',2020]])ctx.fillText(text,280,y);
    ctx.strokeStyle='#32445b';ctx.lineWidth=5;ctx.strokeRect(260,1010,1880,160);
    ctx.font='50px monospace';for(let line=0;line<7;line++)ctx.fillText(`DETALLE ${line+1} - Comprobante legible`,280,2230+line*90);
    const original=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
    const file=new File([original],'comprobante-qa-grande.png',{type:'image/png',lastModified:1791370800000});
    const {prepareReceiptFile,receiptContentType}=await import('/receipt-upload.js');
    const start=performance.now(),processed=await prepareReceiptFile(file),durationMs=performance.now()-start;
    const image=new Image();const processedUrl=URL.createObjectURL(processed);image.src=processedUrl;await image.decode();
    const pdf=new File(['%PDF-1.4\n%LOCAL QA\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n'],'test.pdf',{type:'application/pdf'});
    const pdfAfter=await prepareReceiptFile(pdf);
    const b64=blob=>new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.readAsDataURL(blob);});
    window.__qaReceiptFixture={file,processed,processedUrl};
    return {originalBytes:file.size,processedBytes:processed.size,processedType:processed.type,width:image.naturalWidth,height:image.naturalHeight,durationMs,pdfUnchanged:pdf===pdfAfter&&await pdf.text()===await pdfAfter.text(),mimeFallback:receiptContentType(new File([original],'empty-mime.png')),originalBase64:await b64(file),processedBase64:await b64(processed)};
  });
}
async function ready(page){await page.locator('#app').waitFor({state:'visible'});await page.locator('[data-mode="digital"]').waitFor({state:'visible'});await page.waitForFunction(()=>document.getElementById('syncStatus')?.textContent==='En tiempo real');}
async function prepareCharge(page,mode,file,tag){
  await page.locator(`[data-mode="${mode}"]`).click();await page.locator('#chargeAmount').fill('125000');await page.locator('#saveChargeBtn').click();
  await page.locator('#tourismOriginSearch').fill('Aeropuerto Internacional de Puerto Iguazú');
  await page.locator('#tourismOriginMatches [role="option"]').filter({hasText:'catálogo'}).first().click();
  await page.locator('#tourismDestinationSearch').fill('Terminal de Ómnibus');
  await page.locator('#tourismDestinationMatches [role="option"]').filter({hasText:'catálogo'}).first().click();
  await page.waitForFunction(()=>Number(document.getElementById('chargeDistance')?.value)>0);
  await page.locator('#detail').evaluate((el,tag)=>{el.value=tag;},tag);
  await page.locator('#saveChargeBtn').click();await page.locator('[data-charge-private]').click();await page.locator('#saveChargeBtn').click();
  if(mode==='digital'){await page.locator('#proof').setInputFiles(file);await page.locator('#saveChargeBtn').click();}
  assert.equal(await page.locator('#chargeForm').getAttribute('data-step'),'3');
}
async function observeButton(page,id){await page.evaluate(id=>{window.__qaSaveStates=[];const node=document.getElementById(id);new MutationObserver(()=>window.__qaSaveStates.push(node.textContent)).observe(node,{subtree:true,childList:true,characterData:true});},id);}
function savedByTag(state,collection,tag){return Object.entries(state.records).filter(([p,r])=>p.startsWith(collection+'/')&&r.detail===tag);}
let browser,context,page,active;
try{
  for(const engine of (process.env.UI_ENGINES||'chromium,webkit').split(',')){
    browser=await(engine==='webkit'?webkit:chromium).launch(engine==='chromium'?{channel:'msedge'}:{});
    for(const width of(process.env.UI_WIDTHS||'1440,390').split(',').map(Number)){
      await api({action:'reset'});active={engine,width,height:width===1440?1000:844,steps:[]};report.cases.push(active);
      context=await browser.newContext({viewport:{width,height:active.height},isMobile:width<600,deviceScaleFactor:width<600?2:1,serviceWorkers:'block',timezoneId:'America/Argentina/Buenos_Aires'});
      let uploadCount=0,writeCount=0;
      await context.route('**/*',async route=>{
        const request=route.request(),url=new URL(request.url());
        if(url.origin!==origin){report.blocked.push(url.origin);await route.abort();return;}
        if(url.pathname==='/__preview__/api'&&request.method()==='POST'){
          const body=request.postDataJSON();
          if(body.action==='call'&&body.name==='exploraRoute'){await route.fulfill({json:{places:[]}});return;}
          if(body.action==='upload'){uploadCount++;await new Promise(resolve=>setTimeout(resolve,300));}
          if(body.action==='writes')writeCount++;
        }
        await route.continue();
      });
      page=await context.newPage();page.setDefaultTimeout(20000);page.on('pageerror',e=>report.errors.push(`${engine}-${width}: ${e.message}`));
      await page.goto(origin);await ready(page);
      const fixture=await imageFixture(page),{originalBase64,processedBase64,...stats}=fixture;
      assert.ok(stats.originalBytes>350*1024,'Large PNG exercises real canvas processing');assert.ok(stats.processedBytes<stats.originalBytes*.5,'Meaningful byte reduction');
      assert.ok(Math.max(stats.width,stats.height)<=2000,'Maximum dimension 2000px');assert.equal(stats.pdfUnchanged,true);assert.equal(stats.mimeFallback,'image/png');
      stats.reductionPercent=100*(1-stats.processedBytes/stats.originalBytes);active.image=stats;
      fs.writeFileSync(path.join(output,`${engine}-${width}-processed.jpg`),Buffer.from(processedBase64,'base64'));
      const file={name:'comprobante-qa-grande.png',mimeType:'image/png',buffer:Buffer.from(originalBase64,'base64')};
      if(engine==='chromium'&&width===1440)fs.writeFileSync(path.join(output,'original-receipt.png'),file.buffer);
      active.steps.push('Real image decode and canvas compression; PDF preserves same bytes and object');
      const tag=`QA-DIGITAL-${engine}-${width}`;
      await prepareCharge(page,'digital',file,tag);await observeButton(page,'saveChargeBtn');
      const start=performance.now();await page.locator('#saveChargeBtn').click();
      await page.waitForFunction(()=>document.getElementById('saveChargeBtn')?.textContent.includes('Subiendo comprobante'));
      await page.screenshot({path:path.join(output,`${engine}-${width}-digital-upload.png`),fullPage:true});
      // A second submit while the first runs must keep a single operation.
      await page.locator('#chargeForm').evaluate(el=>el.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
      await page.locator('#chargeModal').waitFor({state:'hidden'});active.digitalLocalSaveMs=performance.now()-start;
      let state=await api({action:'inspect'});const saved=savedByTag(state,'billing_records',tag);assert.equal(saved.length,1);
      assert.equal(saved[0][1].amount,125000);assert.equal(saved[0][1].method,'digital');assert.ok(saved[0][1].proofPath.endsWith('.jpg'));
      active.digitalStates=await page.evaluate(()=>window.__qaSaveStates);assert.ok(active.digitalStates.some(s=>s.includes('Subiendo comprobante')));assert.ok(active.digitalStates.some(s=>s.includes('Guardando cobro')));
      assert.equal(uploadCount,1,'One digital upload');active.steps.push('Digital charge saved exactly once after duplicate submit; upload progress visible; amount unchanged');
      await prepareCharge(page,'cash',file,`QA-CASH-${engine}-${width}`);await page.locator('#saveChargeBtn').click();await page.locator('#chargeModal').waitFor({state:'hidden'});
      state=await api({action:'inspect'});assert.equal(savedByTag(state,'billing_records',`QA-CASH-${engine}-${width}`).length,1);assert.equal(uploadCount,1,'Cash uploads no file');
      active.steps.push('Cash charge saves without an upload');
      await page.locator('#addExpenseBtn').click();await page.locator('[data-expense-type="combustible"]').click();await page.locator('#expenseAmount').fill('50000');await page.locator('#expenseDetail').fill(`QA-EXPENSE-${engine}-${width}`);await page.locator('#saveExpenseBtn').click();await page.locator('#expenseProof').setInputFiles(file);await observeButton(page,'saveExpenseBtn');
      await page.locator('#saveExpenseBtn').click();await page.locator('#expenseModal').waitFor({state:'hidden'});
      state=await api({action:'inspect'});const expenses=savedByTag(state,'gastos',`QA-EXPENSE-${engine}-${width}`);assert.equal(expenses.length,1);assert.equal(expenses[0][1].amount,50000);assert.ok(expenses[0][1].proofPath.endsWith('.jpg'));assert.equal(uploadCount,2);
      active.expenseStates=await page.evaluate(()=>window.__qaSaveStates);assert.ok(active.expenseStates.some(s=>s.includes('Subiendo comprobante')));
      active.steps.push('Expense saves once with compressed proof and unchanged $50,000 amount');
      await page.screenshot({path:path.join(output,`${engine}-${width}-saved.png`),fullPage:true});
      // Controlled local transport failure: prove prompt recovery before any Firestore transaction.
      await prepareCharge(page,'digital',file,`QA-FAILURE-${engine}-${width}`);
      await page.evaluate(()=>{window.__previewFailUpload=true;});const beforeWrites=writeCount,failedStart=performance.now();await page.locator('#saveChargeBtn').click();
      await page.waitForFunction(()=>document.getElementById('chargeStatus')?.classList.contains('error'));
      active.uploadFailureMs=performance.now()-failedStart;assert.ok(active.uploadFailureMs<5000,'Pre-write upload failure should not trigger 13.7s confirmation polling');assert.equal(writeCount,beforeWrites);assert.equal(await page.locator('#saveChargeBtn').isDisabled(),false);
      await page.evaluate(()=>{window.__previewFailUpload=false;});await page.locator('#saveChargeBtn').click();await page.locator('#chargeModal').waitFor({state:'hidden'});
      state=await api({action:'inspect'});assert.equal(savedByTag(state,'billing_records',`QA-FAILURE-${engine}-${width}`).length,1);
      active.steps.push('Injected upload failure returns promptly without a transaction; retry saves exactly once');active.ok=true;
      await context.close();context=null;page=null;
    }
    await browser.close();browser=null;
  }
  assert.deepEqual(report.errors,[],'No unhandled browser errors');report.ok=true;console.log(JSON.stringify({ok:true,cases:report.cases.length,output,images:report.cases.map(c=>({engine:c.engine,viewportWidth:c.width,...c.image}))},null,2));
}catch(error){report.failure=error.stack||String(error);if(active)active.ok=false;if(page)await page.screenshot({path:path.join(output,`${active.engine}-${active.width}-failure.png`),fullPage:true}).catch(()=>{});throw error;}
finally{fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));await context?.close();await browser?.close();await new Promise(resolve=>server.close(resolve));}
