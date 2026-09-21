import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../login-entry.js',import.meta.url),'utf8');
const code=source.slice(source.indexOf('export function'),source.lastIndexOf('\nmountEarlyLogin(')).replace('export function','function');
function setup(currentUser=null){
 const nodes=new Map(),events=new Map();let submissions=0;
 const get=id=>{if(!nodes.has(id)){const classes=new Set(id==='loginScreen'?['hidden']:[]);nodes.set(id,{disabled:false,textContent:'',handlers:new Map(),classList:{add:v=>classes.add(v),remove:v=>classes.delete(v),contains:v=>classes.has(v)},
 addEventListener:(type,fn)=>get(id).handlers.set(type,fn),removeEventListener:(type)=>get(id).handlers.delete(type),requestSubmit:()=>submissions++});}return nodes.get(id);};
 const document={documentElement:{dataset:{}},getElementById:get,addEventListener:(type,fn)=>events.set(type,fn)};
 const context=vm.createContext({});vm.runInContext(code,context);
 context.mountEarlyLogin({document,auth:{currentUser},authReady:new Promise(()=>{}),MutationObserver:class{}});
 return {get,document,events,submissions:()=>submissions};
}
test('el login aparece sin esperar Firebase ni el módulo del panel',async()=>{
 const ui=setup();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(ui.get('loginScreen').classList.contains('hidden'),false);
 assert.equal(ui.get('app').classList.contains('hidden'),true);
 assert.equal(ui.document.documentElement.dataset.exploraLoginVisible,'true');
 const event={preventDefault(){},stopImmediatePropagation(){}};
 ui.get('loginForm').handlers.get('submit')(event);
 ui.get('loginForm').handlers.get('submit')(event);
 assert.equal(ui.submissions(),0);assert.equal(ui.get('loginBtn').disabled,true);
 ui.events.get('explora:app-ready')();
 assert.equal(ui.submissions(),1);assert.equal(ui.get('loginForm').handlers.has('submit'),false);
});
test('el formulario inicial no expone el panel privado aunque haya una sesión restaurada',async()=>{
 const ui=setup({uid:'driver'});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(ui.get('loginScreen').classList.contains('hidden'),false);
 assert.equal(ui.get('app').classList.contains('hidden'),true);
 assert.equal(ui.document.documentElement.dataset.exploraLoginVisible,'true');
 ui.events.get('explora:app-ready')();assert.equal(ui.submissions(),0);
});

test('el primer HTML muestra el formulario sin animación y nunca envía credenciales como formulario nativo',()=>{
 const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
 assert.match(html,/id="loginScreen" class="login-screen"/);
 assert.match(html,/<form id="loginForm"[^>]+onsubmit="return false"/);
 assert.match(html,/id="splashScreen"[^>]+hidden/);
 assert.doesNotMatch(html,/splash-progress|splashProgressArc/);
 assert.doesNotMatch(source,/^import /m);
});
