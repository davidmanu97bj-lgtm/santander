import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {movementColor} from '../movement-colors.js';
const require=createRequire(import.meta.url);
const policy=require('../functions/expense-policy.js');
const version=policy.version;
const cases=[
 ['Cobro digital',{method:'digital'},'green'],
 ['Caja digital',{type:'cashbox_receipt',method:'digital'},'red'],
 ['Cobro efectivo',{method:'cash'},'red'],
 ['Caja efectivo',{type:'cashbox_receipt',method:'cash'},'red'],
 ['Gasto compartido',{type:'expense_receipt',receiptFlowVersion:version,expenseType:'combustible'},'red'],
 ['Reintegro',{type:'expense_reimbursement_receipt',method:'expense'},'green'],
 ['Gasto Explora',{type:'expense_receipt',receiptFlowVersion:version,expenseType:'cubiertas'},'green'],
 ['Gasto chofer',{type:'expense_receipt',receiptFlowVersion:version,expenseType:'multa'},'red'],
 ['Pagar a Explora',{type:'settlement_adjustment',method:'cash',adjustmentDirection:'driver_to_explora'},'green'],
 ['Cobrar a Explora',{type:'settlement_adjustment',method:'digital',adjustmentDirection:'explora_to_driver'},'red']
];
for(const [name,record,expected] of cases) test(`color por operación: ${name}`,()=>{
 const before=structuredClone(record);Object.freeze(record);
 for(const amount of [-100,0,100]) assert.equal(movementColor({...record,amount},{expensePolicy:policy}),expected);
 assert.deepEqual(record,before);
});
test('el catálogo histórico no se convierte al régimen nuevo para colorearlo',()=>{
 assert.equal(movementColor({type:'expense_receipt',expenseType:'cubiertas'},{expensePolicy:policy}),'red');
});
test('Uber y cuentas de adelantos/deudas ajenas al pedido conservan sus tonos anteriores',()=>{
 for(const type of ['uber_receipt','cash_advance','admin_debt','debt_compensation'])
  assert.equal(movementColor({type,method:'cash'}),'');
 assert.equal(movementColor({type:'cashbox_receipt',method:'uber'}),'');
});
const source=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8');
function declaration(name){const start=source.search(new RegExp(`^(?:async )?function ${name}\\(`,'m'));assert.ok(start>=0);return source.slice(start,source.indexOf('\n}',start)+2);}
function harness(){
 const nodes=new Map();const $=id=>{if(!nodes.has(id))nodes.set(id,{value:'',dataset:{},innerHTML:'',textContent:'',classList:{toggle(){}}});return nodes.get(id);};
 const ctx=vm.createContext({$,ExploraExpensePolicy:policy,document:{querySelectorAll:()=>[]},parseMoneyInput:Number,previewSettlementBalance:()=>1406876,normalizedSettlementBalance:Number,money:n=>String(n),signedMoney:n=>(n>0?'+':'')+n,escapeHtml:String,settlementPreviewCopy:()=>({label:'Chofer debe'}),receiptBalanceLabel:n=>String(n)});
 vm.runInContext(declaration('renderChargePreview')+'\n'+declaration('renderExpensePreview')+'\n'+declaration('renderManagementPreview'),ctx);
 return{ctx,$};
}
test('vistas previas: el digital sigue restando 100% y ambas cajas suman 5%',()=>{
 const{ctx,$}=harness();$('chargeAmount').value=85000;$('chargeMode').value='digital';ctx.renderChargePreview();
 assert.equal($('chargeAccountPreview').dataset.movementColor,'green');assert.equal($('chargeCashboxPreview').dataset.movementColor,'red');
 assert.match($('chargeAccountPreview').innerHTML,/−85000/);assert.match($('chargeCashboxPreview').innerHTML,/\+4250/);assert.match($('chargeCashboxPreview').innerHTML,/1326126/);
 $('chargeAmount').value=32500;$('chargeMode').value='cash';ctx.renderChargePreview();
 assert.equal($('chargeAccountPreview').dataset.movementColor,'red');assert.match($('chargeCashboxPreview').innerHTML,/\+1625/);
});
test('gastos: solo el color cambia; bruto +100% y reintegro 0/50/100% permanecen',()=>{
 for(const[type,rate,color]of[['combustible',.5,'red'],['multa',0,'red'],['cubiertas',1,'green']]){
  const{ctx,$}=harness();$('expenseAmount').value=35000;$('expenseType').value=type;ctx.renderExpensePreview();
  assert.equal($('expenseGrossPreview').dataset.movementColor,color);assert.equal($('expenseRefundBlock').dataset.movementColor,'green');
  assert.match($('expenseGrossPreview').innerHTML,/\+35000/);
  assert.equal($('expenseFinalBalance').textContent,String(1406876+35000*(1-rate)));
 }
});
test('Gestión: pagar resta y cobrar suma sin alterar el signo para colorear',()=>{
 const{ctx,$}=harness();$('managementAmount').value=100;
 ctx.managementDirection='driver_to_explora';ctx.renderManagementPreview();assert.equal($('managementPreview').dataset.movementColor,'green');assert.match($('managementPreview').innerHTML,/-100/);
 ctx.managementDirection='explora_to_driver';ctx.renderManagementPreview();assert.equal($('managementPreview').dataset.movementColor,'red');assert.match($('managementPreview').innerHTML,/\+100/);
});
test('todos los puntos de presentación tienen hooks; CSS no cambia estructura',()=>{
 const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
 for(const id of ['managementPay','managementCollect']) assert.match(html,new RegExp(`id="${id}"[^>]*data-movement-color=`));
 for(const mode of ['cash','digital']) assert.match(html,new RegExp(`data-mode="${mode}"[^>]*data-movement-color=`));
 const css=fs.readFileSync(new URL('../movement-colors.css',import.meta.url),'utf8').replace(/\/\*[\s\S]*?\*\//g,'');
 for(const block of css.matchAll(/\{([^{}]+)\}/g))for(const declaration of block[1].split(';').filter(s=>s.trim())){
  const name=declaration.split(':')[0].trim();assert.ok(name.startsWith('--')||['color','background','outline-color'].includes(name),name);
 }
});
