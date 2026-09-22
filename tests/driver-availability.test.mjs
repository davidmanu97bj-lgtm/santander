import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import {MemoryStore} from '../tools/preview/memory-store.mjs';
import {availabilityDay,availabilityGroups,whatsappLink} from '../driver-availability.js';
const require=createRequire(import.meta.url),{createAvailabilityService,dayKey,normalizePhone,CLAIMS_DOC_ID}=require('../functions/driver-availability');
function fixture(){const seed={};for(const uid of ['javier','ramiro','inactive']){seed['choferes/'+uid]={nombre:uid,active:uid!=='inactive'};seed['usuarios/'+uid]={nombre:uid,active:uid!=='inactive'};seed['driver_availability/'+uid]={uid,name:uid,active:uid!=='inactive',phone:'5493757123456',status:'unknown',revision:0};}const db=new MemoryStore(seed);let stamp=Date.parse('2026-09-21T15:00:00Z');const service=createAvailabilityService({db,adminUid:'admin',now:()=>stamp});return {db,service,setTime:v=>stamp=Date.parse(v)};}
const claimsPath=()=>'driver_availability_days/'+CLAIMS_DOC_ID;
const request=(uid,number=null,extra={})=>({auth:{uid},data:{status:'free',zone:'Ciudad',number,operationId:crypto.randomUUID(),expectedRevision:0,...extra}});
test('WhatsApp normaliza países y rechaza formatos ambiguos',()=>{
 for(const raw of ['3757 123456','9 3757 123456','+54 9 3757 123456','5493757123456','005493757123456'])assert.equal(normalizePhone('54',raw),'5493757123456');
 assert.equal(normalizePhone('55','45 99999-1234'),'5545999991234');assert.equal(normalizePhone('595','981123456'),'595981123456');
 for(const [cc,n] of [['54','03757 15 123456'],['54','+55 45999991234'],['54','javascript:1234567890'],['54','1'],['99','1234567890']])assert.throws(()=>normalizePhone(cc,n));
});
test('dos solicitudes simultáneas no adjudican el mismo número y el reintento no duplica eventos',async()=>{
 const {db,service}=fixture(),a=request('javier',57),b=request('ramiro',57);const results=await Promise.allSettled([service.change(a),service.change(b)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results[1].reason.code,'already-exists');
 await service.change(a);assert.equal([...db.data.keys()].filter(k=>k.startsWith('driver_availability_events/')).length,1);
 assert.equal(db.data.get(claimsPath()).claims[57].uid,'javier');
 assert.equal(db.data.get('driver_availability/ramiro').status,'unknown');
 await assert.rejects(service.change({...a,data:{...a.data,zone:'Brasil',number:null}}),{code:'already-exists'});
});
test('un estado ocupado sin adjudicación también suelta el número anterior',async()=>{
 const {db,service}=fixture();await service.change(request('javier',57));await service.change(request('javier',null,{status:'busy',zone:'Brasil',expectedRevision:1}));
 assert.equal(whatsappLink(db.data.get('driver_availability/javier')),null);
 assert.equal((await service.change(request('ramiro',57))).number,57);
 assert.equal(db.data.get('driver_availability/javier').number,null);
 assert.equal(db.data.get(claimsPath()).claims[57].uid,'ramiro');
});
test('medianoche argentina no borra reservas; ensureDay solo avanza el día del doc persistente',async()=>{
 const {db,service,setTime}=fixture();setTime('2026-09-22T02:59:59Z');await service.change(request('javier',43));
 assert.equal(dayKey(Date.parse('2026-09-22T02:59:59Z')),'2026-09-21');
 assert.equal(db.data.get(claimsPath()).claims[43].uid,'javier');
 setTime('2026-09-22T03:00:00Z');
 assert.equal(availabilityDay(Date.parse('2026-09-22T03:00:00Z')),'2026-09-22');
 await service.ensureDay();await service.ensureDay();
 assert.equal(db.data.get(claimsPath()).claims[43].uid,'javier');
 assert.equal(db.data.get(claimsPath()).day,'2026-09-22');
 assert.equal(db.data.get('driver_availability/javier').number,43);
 assert.equal(db.data.get('driver_availability/javier').numberDay,'2026-09-21');
 // Otro chofer no puede tomar el mismo número al día siguiente.
 await assert.rejects(service.change(request('ramiro',43)),{code:'already-exists'});
 // Sí puede tomar otro número libre.
 assert.equal((await service.change(request('ramiro',57))).number,57);
 assert.deepEqual(Object.keys(db.data.get(claimsPath()).claims).sort(),['43','57']);
});
test('solo el dueño puede cargar WhatsApp inicial y solo admin puede editar; todo cambio deja auditoría',async()=>{
 const {db,service}=fixture();db.data.get('driver_availability/javier').phone='';
 await service.savePhone({auth:{uid:'javier'},data:{phone:'3757123456',country:'54'}});
 await service.savePhone({auth:{uid:'javier'},data:{phone:'3757123456',country:'54'}});
 await assert.rejects(service.savePhone({auth:{uid:'javier'},data:{phone:'3757123457',country:'54'}}),{code:'permission-denied'});
 await assert.rejects(service.savePhone({auth:{uid:'ramiro'},data:{uid:'javier',phone:'3757123457',country:'54'}}),{code:'permission-denied'});
 await service.savePhone({auth:{uid:'admin'},data:{uid:'javier',phone:'3757123457',country:'54'}});
 assert.equal(db.data.get('driver_availability/javier').phone,'5493757123457');assert.equal([...db.data.keys()].filter(k=>k.startsWith('availability_phone_audit/')).length,2);
});
test('rechaza inactivos, revisión vieja, zona falsa, número inválido y adjudicar ocupado o Brasil',async()=>{
 const {service,db}=fixture();await assert.rejects(service.change(request('inactive',28)),{code:'permission-denied'});
 for(const extra of [{status:'busy',number:28},{zone:'Brasil',number:28},{zone:'Foz'},{number:999},{expectedRevision:9}])await assert.rejects(service.change(request('javier',null,extra)));
 db.data.get('driver_availability/javier').phone='';await assert.rejects(service.change(request('javier')),{code:'failed-precondition'});
 assert.equal([...db.data.keys()].filter(k=>k.startsWith('driver_availability_events/')).length,0);
});
test('perfil desactivado deja de aparecer sin perder teléfono; no expone campos de perfil privado',async()=>{
 const {service,db}=fixture();db.data.get('usuarios/javier').active=false;await service.syncDriver('javier');assert.equal(db.data.get('driver_availability/javier').active,false);assert.equal(db.data.get('driver_availability/javier').phone,'5493757123456');
 await assert.rejects(service.bootstrap({auth:{uid:'inactive'}}),{code:'permission-denied'});
 await assert.rejects(service.bootstrap({}),{code:'unauthenticated'});
});
test('ordena Tu estado, libres, ocupados; contactos solo libres y enlaces seguros en la misma pestaña',()=>{
 const rows=[{uid:'me',name:'Javier',status:'busy',active:true,number:57},{uid:'b',name:'Marcelo',status:'busy',active:true,number:104},{uid:'c',name:'Ramiro',status:'free',phone:'5493757123456',active:true}];
 assert.deepEqual(availabilityGroups(rows,'me').map(g=>g.title),['Tu estado','Libres','Ocupados']);
 assert.equal(whatsappLink(rows[2]),'https://wa.me/5493757123456');assert.equal(whatsappLink({...rows[2],phone:'javascript:alert(1)'}),null);
 const source=fs.readFileSync(new URL('../driver-availability.js',import.meta.url),'utf8');
 assert.match(source,/target="_self"/);assert.doesNotMatch(source,/window\.open|target="_blank"/);
 assert.match(source,/OCUPADO CON EL/);
 assert.doesNotMatch(source,/p\.zone\?' en '/);
 assert.match(source,/listenDay\('active'/);
 assert.match(source,/title:'Tu estado'/);
});
test('las colecciones de disponibilidad no admiten escrituras desde el navegador',()=>{
 const rules=fs.readFileSync(new URL('../firestore.rules',import.meta.url),'utf8');for(const col of ['driver_availability','driver_availability_days']){const block=rules.split('match /'+col+'/')[1].split('\n    }')[0];assert.match(block,/allow write: if false/);assert.match(block,/isActiveTeamViewer/);}
});

test('Telegram: libre, ocupado y adjudicacion usan texto corto sin zona ni acentos',async()=>{
 const {db,service}=fixture();
 const free=await service.change(request('javier',null,{status:'free',zone:'Aeropuerto'}));
 assert.equal(free.status,'free');
 const freeText=[...db.data.entries()].find(([k])=>k.startsWith('driver_availability_events/'))[1].text;
 assert.equal(freeText,'JAVIER ESTA LIBRE');
 const busyReq=request('javier',null,{status:'busy',zone:'Brasil',expectedRevision:1});
 await service.change(busyReq);
 const busyText=[...db.data.entries()].filter(([k])=>k.startsWith('driver_availability_events/')).at(-1)[1].text;
 assert.equal(busyText,'JAVIER ESTA OCUPADO');
 await service.change(request('javier',57,{expectedRevision:2}));
 const claimText=[...db.data.entries()].filter(([k])=>k.startsWith('driver_availability_events/')).at(-1)[1].text;
 assert.equal(claimText,'JAVIER SE ADJUDICO EL 57');
 assert.doesNotMatch(claimText,/OCUPADO|EN |ESTÁ|ADJUDICÓ/);
});
test('adjudicar deja ocupado, oculta WhatsApp y limita nuevas adjudicaciones durante 30 minutos',async()=>{
 const {db,service,setTime}=fixture();const first=request('javier',57);const assigned=await service.change(first);
 assert.equal(assigned.status,'busy');assert.equal(assigned.number,57);assert.equal(whatsappLink(db.data.get('driver_availability/javier')),null);
 assert.equal([...db.data.entries()].find(([k])=>k.startsWith('driver_availability_events/'))[1].text,'JAVIER SE ADJUDICO EL 57');
 await service.change(request('javier',null,{expectedRevision:1}));assert.equal(db.data.get('driver_availability/javier').status,'free');
 setTime('2026-09-21T15:29:59Z');await assert.rejects(service.change(request('javier',43,{expectedRevision:2})),{code:'resource-exhausted'});
 assert.equal(db.data.get('driver_availability/javier').revision,2);assert.equal(db.data.get(claimsPath()).claims[43],undefined);
 assert.deepEqual(await service.change(first),assigned);
 setTime('2026-09-21T15:30:00Z');const second=await service.change(request('javier',43,{expectedRevision:2}));assert.equal(second.status,'busy');assert.equal(second.number,43);
});
test('la espera sobrevive medianoche y los cambios sin número',async()=>{
 const {service,setTime}=fixture();setTime('2026-09-22T02:50:00Z');await service.change(request('javier',28));
 setTime('2026-09-22T03:00:00Z');await service.change(request('javier',null,{expectedRevision:1}));
 await assert.rejects(service.change(request('javier',57,{expectedRevision:2})),{code:'resource-exhausted'});
 setTime('2026-09-22T03:20:00Z');assert.equal((await service.change(request('javier',57,{expectedRevision:2}))).status,'busy');
});
test('dos dispositivos del mismo chofer no adjudican dos números simultáneamente',async()=>{
 const {db,service}=fixture();const results=await Promise.allSettled([service.change(request('javier',28)),service.change(request('javier',57))]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(Object.keys(db.data.get(claimsPath()).claims).length,1);
});

test('quedar libre borra el número, libera el tachado para otro chofer y conserva la espera propia',async()=>{
 const {db,service}=fixture();await service.change(request('javier',57));
 const releasedRequest=request('javier',null,{expectedRevision:1});const released=await service.change(releasedRequest);
 assert.equal(released.status,'free');assert.equal(released.number,null);assert.equal(released.numberDay,'');
 assert.equal(db.data.get(claimsPath()).claims[57],undefined);
 assert.ok(whatsappLink(db.data.get('driver_availability/javier')));
 assert.equal((await service.change(request('ramiro',57))).status,'busy');
 await service.change(releasedRequest);
 assert.equal(db.data.get(claimsPath()).claims[57].uid,'ramiro');
 await assert.rejects(service.change(request('javier',43,{expectedRevision:2})),{code:'resource-exhausted'});
});
test('reemplazar adjudicación tras 30 minutos no deja números anteriores tachados',async()=>{
 const {db,service,setTime}=fixture();await service.change(request('javier',28));setTime('2026-09-21T15:30:00Z');
 await service.change(request('javier',57,{expectedRevision:1}));
 assert.deepEqual(Object.keys(db.data.get(claimsPath()).claims),['57']);
});
test('tras medianoche el dueño libera su número y otro lo puede tomar; claims siguen en el doc active',async()=>{
 const {db,service,setTime}=fixture();setTime('2026-09-22T02:30:00Z');await service.change(request('javier',57));
 setTime('2026-09-22T03:05:00Z');await service.ensureDay();
 assert.equal(db.data.get(claimsPath()).claims[57].uid,'javier');
 await service.change(request('javier',null,{expectedRevision:1}));
 assert.equal(db.data.get(claimsPath()).claims[57],undefined);
 assert.equal((await service.change(request('ramiro',57))).number,57);
 assert.equal(db.data.get(claimsPath()).day,'2026-09-22');
 assert.equal(db.data.get(claimsPath()).persistent,true);
});
test('ensureDay migra claims de un doc calendario legacy al doc active sin borrarlos',async()=>{
 const {db,service,setTime}=fixture();
 db.data.set('driver_availability_days/2026-09-21',{day:'2026-09-21',claims:{57:{uid:'javier',claimedAtMs:1}},createdAtMs:1});
 setTime('2026-09-21T15:00:00Z');await service.ensureDay();
 assert.equal(db.data.get(claimsPath()).claims[57].uid,'javier');
 assert.equal(db.data.get(claimsPath()).persistent,true);
});
