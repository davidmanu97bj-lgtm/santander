// Local-only browser check. Run after npm ci, with an installed Playwright browser.
// Uses the real app and its existing memory-backed preview; never contacts Firebase.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {chromium,webkit} from 'playwright';
import {ROOT} from './project.mjs';
import {opsDayKey} from '../ops-salidas.js';

const statePath=path.resolve(ROOT,'../preview-admin-state.json');
assert.ok(!fs.existsSync(statePath),'Move aside the existing local preview state before this isolated check.');
process.env.PREVIEW_ROLE='admin';
const {server}=await import('./preview.mjs');
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const api=async body=>{
  const response=await fetch(origin+'/__preview__/api',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.ok(response.ok);return response.json();
};
const output=path.resolve(ROOT,'../charge-classification-evidence');fs.mkdirSync(output,{recursive:true});
let browser;
try {
  const initial=await api({action:'inspect'});
  await api({action:'writes',writes:Object.keys(initial.records).filter(p=>p.startsWith('billing_records/')).map(path=>({target:{path},remove:true}))});
  const now=Date.now(),dayKey=opsDayKey(now);
  const definitions=[
    ['number',134,false,false,'Aeropuerto → Hotel'],
    ['private',null,true,true,'Viaje privado registrado'],
    ['legacy',undefined,undefined,undefined,'Registro anterior'],
    ['conflict',43,true,false,'Datos contradictorios'],
    ['candidate-a',57,false,false,'Candidato A'],
    ['candidate-b',57,undefined,undefined,'Candidato B'],
    ['invalid','incorrecto',false,false,'Número inválido']
  ];
  for(const [id,remisNumber,viajePrivado,isPrivateTrip,detail] of definitions){
    await api({action:'set',target:{path:'billing_records/'+id},data:{id,driverUid:'preview-driver',uid:'preview-driver',driverName:'Javier de prueba',method:'cash',amount:12000,type:'billing',status:'completed',detail,createdAtMs:now-60000,dayKey,remisNumber,viajePrivado,isPrivateTrip}});
  }
  for(const [id,remisNumber,paymentId,disposition] of [
    ['linked',134,'number','own'],['private-link',28,'private','external_cover'],
    ['legacy-link',31,'legacy','own'],['conflict-link',43,'conflict','own'],['ambiguous',57,null,'own']
  ])await api({action:'set',target:{path:'ops_number_exits/'+id},data:{id,remisNumber,paymentId,disposition,active:true,markedAtMs:now-3600000,createdAt:now,dayKey,sourceRef:'LOCAL '+id,reviewNote:disposition==='external_cover'?'Cobertura externa de prueba':''}});
  const before=await api({action:'inspect'});
  for(const engine of (process.env.UI_ENGINES||'chromium').split(',')){
    browser=await (engine==='webkit'?webkit:chromium).launch(engine==='chromium'?{channel:process.env.UI_BROWSER_CHANNEL||'msedge'}:{});
    const page=await browser.newPage();const errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
    for(const width of [1440,768,390,320]){
      await page.setViewportSize({width,height:1000});await page.goto(origin);
      await page.locator('.ops-charge-classification').first().waitFor();
      assert.deepEqual((await page.locator('.ops-charge-classification strong').allTextContents()).sort(),['Nº remis 134','Por revisar','Sin clasificar','Viaje privado'].sort());
      const candidates=page.locator('.ops-charge-candidates');
      for(let cycle=0;cycle<2;cycle++){
        await candidates.locator('summary').click();
        assert.equal(await candidates.locator('p').count(),2);
        assert.ok((await candidates.innerText()).includes('Nº remis 57'));
        assert.ok((await candidates.innerText()).includes('$12.000'));
        await candidates.locator('summary').click();
      }
      await page.locator('[data-ops-filter]').selectOption('matched');
      assert.equal(await page.locator('.ops-charge-classification').count(),1);
      await page.locator('[data-ops-filter]').selectOption('all');
      assert.equal(await page.locator('.ops-charge-classification').count(),4);
      await candidates.locator('summary').click();
      // Repaint through the existing UI; an expanded candidate must remain readable.
      await page.locator('[data-ops-number="15"]').click();
      assert.equal(await candidates.getAttribute('open'),'');
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${engine} ${width}: page overflow`);
      await page.locator('.ops-salidas-table-wrap').evaluate(el=>{
        const charge=el.querySelector('tbody td:nth-child(5)');
        el.scrollLeft+=charge.getBoundingClientRect().left-el.getBoundingClientRect().left;
      });
      await page.locator('.ops-salidas-table-wrap').screenshot({path:path.join(output,`${engine}-${width}-ops.png`)});
      if(width>=768){
        for(let cycle=0;cycle<2;cycle++){
          await page.locator('[data-admin-view="movements"]').click();
          await page.locator('.admin-charge-classification').first().waitFor();
          const labels=await page.locator('.admin-charge-classification').allTextContents();
          assert.equal(labels.length,7);
          for(const label of ['Nº remis 134','Viaje privado','Sin clasificar','Por revisar'])assert.ok(labels.includes(label));
          await page.locator('[data-admin-view="overview"]').click();
        }
        await page.locator('[data-admin-view="movements"]').click();
        await page.locator('#adminActivityType').selectOption('cash');
        assert.equal(await page.locator('.admin-charge-classification').count(),7);
        await page.locator('#adminActivityTable').screenshot({path:path.join(output,`${engine}-${width}-movements.png`)});
      } else {
        // Existing product policy: Movimientos is notebook-only; Ops remains mobile.
        assert.equal(await page.locator('[data-admin-view="movements"]').isVisible(),false);
      }
      console.log(`${engine} ${width}: labels, candidate open/close/reopen, filter return, navigation and overflow OK`);
    }
    assert.deepEqual(errors,[]);await browser.close();browser=null;
  }
  // The existing availability bootstrap updates its local presence documents on login.
  // Every other record (including billing, debts, exits and any new financial collection) must stay unchanged.
  const withoutAvailability=state=>({...state,records:Object.fromEntries(Object.entries(state.records).filter(([key])=>!/^driver_availability(?:_days)?\//.test(key)))});
  assert.deepEqual(withoutAvailability(await api({action:'inspect'})),withoutAvailability(before),'Inspecting classifications must not write financial records or exits');
  console.log('No financial or exit writes; screenshots: '+output);
} finally {
  await browser?.close();await new Promise(resolve=>server.close(resolve));
  // This exact file was absent on entry and was created by this local test only.
  fs.rmSync(statePath,{force:true});
}
