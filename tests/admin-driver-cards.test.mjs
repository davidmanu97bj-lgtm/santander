import test from 'node:test';
import assert from 'node:assert/strict';
import {filterAdminRows,renderDriverCards,adminProofMarkup,mountAdminWorkspace} from '../admin-workspace.js';

test('driver cards keep signed balances and scope all seven actions by stable UID',()=>{
  const accounts=[{uid:'one',name:'David Gómez',balance:12500},{uid:'two',name:'David Gómez',balance:-800},{uid:'three',name:'Javier Allende',balance:0}];
  const before=structuredClone(accounts),markup=renderDriverCards(accounts);
  assert.equal((markup.match(/data-admin-driver-action=/g)||[]).length,21);
  for(const {uid} of accounts)assert.equal((markup.match(new RegExp(`data-driver-uid="${uid}"`,'g'))||[]).length,7);
  for(const action of ['movements','closures','receipts','accountant','invoices','digital','debt'])assert.equal((markup.match(new RegExp(`data-admin-driver-action="${action}"`,'g'))||[]).length,3);
  assert.match(markup,/Chofer debe/);assert.match(markup,/Explora debe/);assert.match(markup,/Al día/);
  assert.deepEqual(accounts,before,'rendering must not mutate financial inputs');
  assert.doesNotMatch(renderDriverCards(accounts,{ready:false}),/data-admin-driver-action/);
});

test('same names, unowned rows and conflicting aliases cannot leak into another driver view',()=>{
  const time=Date.parse('2026-10-01T01:00:00Z');
  const rows=[
    {id:'one',driverUid:'one',driver:'David Gómez',kind:'digital',detail:'Cataratas',time},
    {id:'two',driverUid:'two',uid:'one',driver:'David Gómez',kind:'digital',detail:'Cataratas',time},
    {id:'legacy',driver:'David Gómez',kind:'digital',detail:'Cataratas',time}
  ];
  assert.deepEqual(filterAdminRows(rows,{driverUid:'one',month:'2026-09'}).map(r=>r.id),['one']);
  assert.deepEqual(filterAdminRows(rows,{driverUid:'two',search:'gomez'}).map(r=>r.id),['two']);
  assert.deepEqual(filterAdminRows(rows,{driverUid:''}),[]);
  assert.deepEqual(filterAdminRows(rows,{driverUid:'one',month:'2026-10'}),[]);
});

test('names are escaped and an admin waiver is distinct from a missing attachment',()=>{
  const markup=renderDriverCards([{uid:'driver" onmouseover="bad',name:'<script>bad</script>',balance:0}]);
  assert.doesNotMatch(markup,/<script>/);assert.match(markup,/&lt;script&gt;/);assert.match(markup,/driver&quot; onmouseover=&quot;bad/);
  assert.match(adminProofMarkup({receiptStatus:'waived_by_admin',receiptWaivedByUid:'admin'}),/Sin comprobante · administración/);
  assert.match(adminProofMarkup({receiptStatus:'waived_by_admin',receiptWaivedByUid:'admin',receiptWaivedAtMs:Date.parse('2026-10-07T18:30:00Z')}),/Registrado 07\/10\/26, 15:30/);
  assert.doesNotThrow(()=>adminProofMarkup({receiptStatus:'waived_by_admin',receiptWaivedByUid:'admin',receiptWaivedAtMs:'invalid'}));
  assert.match(adminProofMarkup({receiptStatus:'waived_by_admin'}),/Sin adjunto/);
  assert.match(adminProofMarkup({proof:'javascript:alert(1)'}),/Sin adjunto/);
  assert.match(adminProofMarkup({proof:'https://example.test/document.pdf'}),/Ver comprobante/);
});

function fakeDocument(){
  const nodes=new Map();
  function element(id,dataset={}){
    let html='';
    return {id,dataset,hidden:false,disabled:false,value:'',textContent:'',listeners:{},
      classList:{toggle(){}},setAttribute(){},removeAttribute(){},focus(){},scrollIntoView(){},
      contains(){return false;},querySelectorAll(){return [];},
      addEventListener(event,callback){this.listeners[event]=callback;},
      get innerHTML(){return html;},set innerHTML(value){html=value;if(id.endsWith('Month'))this.value=value.match(/value="([^"]+)"/)?.[1]||'';}
    };
  }
  const panels=['overview','operations','movements','closures','receipts','accountant'].map(view=>element('',{adminPanel:view}));
  const operation=element('adminOperationsBtn',{adminView:'operations'}),scopeName=element('scope');
  return {activeElement:{},getElementById(id){if(!nodes.has(id))nodes.set(id,element(id));return nodes.get(id);},
    querySelectorAll(selector){if(selector==='[data-admin-panel]')return panels;if(selector==='[data-admin-view]')return [operation];if(selector==='[data-admin-scoped-name]')return [scopeName];return [];}
  };
}

test('scoped navigation requests only one driver and rejects stale monthly results',async()=>{
  const original=globalThis.document,doc=fakeDocument();globalThis.document=doc;
  const accounts=[{uid:'one',name:'David Gómez',balance:1},{uid:'two',name:'Javier Allende',balance:2}];
  let authorized=true;const requests=[];
  const state=()=>({authorized,ready:true,accounts,movements:[],closures:[]});
  try{
    const workspace=mountAdminWorkspace({getState:state,loadDocuments:input=>new Promise(resolve=>requests.push({input,resolve})),openDebt(){},openDigital(){}});
    assert.equal(workspace.openDriverView('accountant','missing'),false);
    assert.equal(workspace.openDriverView('accountant','one'),true);
    assert.deepEqual(requests[0].input,{month:doc.getElementById('adminDocumentsMonth').value,driverUid:'one',overviewOnly:true});
    workspace.openDriverView('accountant','two');
    assert.equal(workspace.getSelectedDriverUid(),'two');
    assert.equal(doc.getElementById('adminWorkspaceSubtitle').textContent,'Javier Allende');
    const row=(uid,name)=>({uid,name,issues:[],invoices:[],closedMonth:true,totals:{gross:100,participation:40}});
    requests[1].resolve({rows:[row('two','Javier Allende'),row('one','David Gómez')]});await Promise.resolve();
    assert.match(doc.getElementById('adminDocumentsTable').innerHTML,/Javier Allende/);
    assert.doesNotMatch(doc.getElementById('adminDocumentsTable').innerHTML,/David Gómez/);
    requests[0].resolve({rows:[row('one','David Gómez')]});await Promise.resolve();
    assert.doesNotMatch(doc.getElementById('adminDocumentsTable').innerHTML,/David Gómez/);
    workspace.openDriverView('overview');
    doc.getElementById('adminDocumentsStatus').textContent='Preparando el PDF del chofer…';
    workspace.openDriverView('accountant','two');
    assert.equal(requests.length,2,'return to the already loaded driver does not fetch the team again');
    assert.equal(doc.getElementById('adminDocumentsStatus').textContent,'');
    assert.equal(doc.getElementById('adminRefreshDocuments').disabled,false);
    authorized=false;assert.equal(workspace.openDriverView('movements','one'),false);
    workspace.reset();assert.equal(workspace.getSelectedDriverUid(),null);
    assert.equal(doc.getElementById('adminDocumentsTable').innerHTML,'');
  }finally{globalThis.document=original;}
});

test('card action does not dispatch unknown drivers or bypass authorization',()=>{
  const original=globalThis.document,doc=fakeDocument();globalThis.document=doc;
  let authorized=true,ready=true;const calls=[];
  try{
    mountAdminWorkspace({getState:()=>({authorized,ready,accounts:[{uid:'one',name:'David',balance:0}],movements:[],closures:[]}),loadDocuments(){},openDebt(){},openDigital(){},onDriverAction:(action,uid)=>calls.push({action,uid})});
    const click=(action,uid)=>doc.getElementById('adminDriverList').listeners.click({target:{closest:()=>({dataset:{adminDriverAction:action,driverUid:uid}})}});
    click('digital','one');click('debt','missing');click('unknown','one');
    ready=false;click('invoices','one');ready=true;authorized=false;click('debt','one');
    assert.deepEqual(calls,[{action:'digital',uid:'one'}]);
  }finally{globalThis.document=original;}
});

test('receipts render in bounded pages without dropping records and reset for a different driver or month',()=>{
  const original=globalThis.document,doc=fakeDocument();globalThis.document=doc;
  const time=Date.parse('2026-09-20T12:00:00Z');
  const movements=Array.from({length:121},(_,i)=>({id:String(i),driverUid:'one',time:time-i,amount:i,detail:`Movimiento ${i}`,proof:`https://example.test/${i}.pdf`}));
  movements.push({id:'other',driverUid:'two',time,amount:1,detail:'Otro chofer',proof:'https://example.test/other.pdf'});
  let authorized=true,ready=true;
  const getState=()=>({authorized,ready,accounts:[{uid:'one',name:'David',balance:0},{uid:'two',name:'Javier',balance:0}],movements,closures:[]});
  try{
    const workspace=mountAdminWorkspace({getState,loadDocuments(){},openDebt(){},openDigital(){}});
    const host=doc.getElementById('adminReceiptsTable');
    doc.getElementById('adminReceiptsMonth').value='2026-09';
    workspace.openDriverView('receipts','one');
    const rows=()=>[...host.innerHTML.matchAll(/href="https:\/\/example.test\/([^\"]+)\.pdf"/g)].map(match=>match[1]);
    const more=()=>host.listeners.click({target:{closest:()=>({dataset:{adminMoreRecords:''}})}});
    assert.equal(rows().length,50);assert.match(host.innerHTML,/50 de 121/);
    assert.doesNotMatch(host.innerHTML,/Otro chofer/);
    more();assert.equal(rows().length,100);assert.match(host.innerHTML,/100 de 121/);
    more();assert.equal(rows().length,121);assert.equal(new Set(rows()).size,121);
    assert.doesNotMatch(host.innerHTML,/data-admin-more-records/);
    workspace.openDriverView('receipts','two');assert.deepEqual(rows(),['other']);
    workspace.openDriverView('receipts','one');assert.equal(rows().length,50);
    more();doc.getElementById('adminReceiptsMonth').onchange();assert.equal(rows().length,50);
    authorized=false;more();assert.equal(rows().length,50);
    authorized=true;ready=false;workspace.refresh();assert.match(host.innerHTML,/Sincronizando comprobantes/);assert.deepEqual(rows(),[]);
  }finally{globalThis.document=original;}
});

test('closures paginate and scoped refreshes leave hidden driver cards untouched',()=>{
  const original=globalThis.document,doc=fakeDocument();globalThis.document=doc;
  const accounts=[{uid:'one',name:'David',balance:0}];
  const closures=Array.from({length:55},(_,i)=>({driverUid:'one',time:Date.now()-i,amount:i,detail:`Cierre ${i}`,status:'Completado',proof:`https://example.test/${i}.pdf`}));
  try{
    const workspace=mountAdminWorkspace({getState:()=>({authorized:true,ready:true,accounts,movements:[],closures}),loadDocuments(){},openDebt(){},openDigital(){}});
    workspace.refresh();const initialCards=doc.getElementById('adminDriverList').innerHTML;
    workspace.openDriverView('closures','one');accounts[0].balance=300;
    workspace.refresh();assert.equal(doc.getElementById('adminDriverList').innerHTML,initialCards);
    const host=doc.getElementById('adminClosuresTable'),rows=()=>host.innerHTML.match(/Ver comprobante/g)||[];
    assert.equal(rows().length,50);assert.match(host.innerHTML,/50 de 55/);
    host.listeners.click({target:{closest:()=>({})}});assert.equal(rows().length,55);
    assert.doesNotMatch(host.innerHTML,/data-admin-more-records/);
    workspace.openDriverView('overview');assert.notEqual(doc.getElementById('adminDriverList').innerHTML,initialCards);
  }finally{globalThis.document=original;}
});
