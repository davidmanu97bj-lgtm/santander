const $=id=>document.getElementById(id);
const numbers=[28,57,104,31,15,154,43,134],zones=['Ciudad','Aeropuerto','Brasil','Paraguay'];
const me={name:'Javier',free:true,zone:'',number:null},others=[{name:'Marcelo',free:false,zone:'Brasil'},{name:'Ramiro',free:true,zone:'Ciudad',number:43},{name:'David',free:false,zone:'Ciudad'}];
let editing=false,pendingZone='',admin=false;
const claimedNumbers=new Set([43]);
const whatsappIcon='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M20 11.5a8 8 0 0 1-11.9 7L4 20l1.5-4.1A8 8 0 1 1 20 11.5Z"/><path d="M8.5 7.5c.5 4 2.5 6 6.5 7l1-2-2-1-1 1-2-2 1-1-1-2Z"/></svg>';
function note(text){$('notice').textContent=text+' · Solo vista previa.';}
function render(){
 $('availability').className='availability '+(me.free?'free':'busy')+(editing?' choosing':'');$('stateTitle').textContent=me.free?'Estás LIBRE':'Estás OCUPADO';$('stateDetail').textContent=(me.zone?'En '+me.zone:me.free?'Disponible para recibir viajes':'Elegí dónde estás')+(me.number?' · por '+me.number:'');
 $('freeCount').textContent=[me,...others].filter(p=>p.free).length;$('busyCount').textContent=[me,...others].filter(p=>!p.free).length;$('change').setAttribute('aria-expanded',String(editing));$('stateEditor').hidden=!editing;
 if(editing){$('stateEditor').innerHTML=`<h2>${me.free?'LIBRE EN':'OCUPADO EN'}</h2><div class="zone-grid">${zones.map(z=>`<button data-zone="${z}">${z}</button>`).join('')}</div>`;$('stateEditor').querySelectorAll('[data-zone]').forEach(b=>b.onclick=()=>selectZone(b.dataset.zone));}
 renderPeople();
}
function selectZone(zone){
 const card=$('availability');
 card.classList.add('confirming');
 $('stateEditor').innerHTML='<div class="state-confirmation" role="status">'+(me.free?'LIBRE':'OCUPADO')+' EN '+zone.toUpperCase()+'</div>';
 setTimeout(()=>{card.classList.remove('confirming');showNumberChoice(zone);},700);
}
function showNumberChoice(zone){me.zone=zone;me.number=null;pendingZone=zone;if(me.free&&['Ciudad','Aeropuerto'].includes(zone)){const taken=claimedNumbers;$('stateDetail').textContent='En '+zone;$('stateEditor').innerHTML=`<h2>¿Adjudicar un número?</h2><div class="number-grid">${numbers.map(n=>`<button data-number="${n}" ${taken.has(n)?'disabled aria-label="'+n+', ya elegido"':''}>${n}</button>`).join('')}</div><p>Los números tachados ya fueron elegidos.</p><button class="no-number" id="noNumber">No, quedar libre sin número</button>`;$('stateEditor').querySelectorAll('[data-number]').forEach(b=>b.onclick=()=>finish(Number(b.dataset.number)));$('noNumber').onclick=()=>finish(null);}else finish(null);}
function finish(number){if(number)claimedNumbers.add(number);me.number=number;editing=false;note(number?`JAVIER SE ADJUDICÓ ${number}`:`JAVIER ESTÁ ${me.free?'LIBRE':'OCUPADO'} EN ${pendingZone.toUpperCase()}`);render();}
function renderPeople(){
 const ordered=[...others.filter(p=>p.free),me,...others.filter(p=>!p.free)];
 $('driverRows').innerHTML=ordered.map((p,i)=>`${p===me?'<h3 class="availability-group">Tu estado</h3>':i===0&&p.free?'<h3 class="availability-group">Libres</h3>':!p.free&&(i===0||ordered[i-1]===me)?'<h3 class="availability-group">Ocupados</h3>':''}<div class="person ${p===me?'self-person':''}"><div class="avatar">${p.name[0]}</div><div class="person-info"><strong>${p.name}</strong>${p===me?'<span class="you">Vos</span>':''}<p><i class="${p.free?'green':'red'}"></i> ${p.free?'Libre':'Ocupado'}${p.zone?' en '+p.zone:''}${p.number?` <strong class="assigned-number">· POR ${p.number}</strong>`:''}</p>${admin?`<button class="edit-phone" data-edit="${p.name}">Editar número</button>`:''}</div>${p.free&&p!==me?`<button class="whatsapp" aria-label="WhatsApp de ${p.name}, demostración">${whatsappIcon}</button>`:''}</div>`).join('');
 $('driverRows').querySelectorAll('.whatsapp').forEach(b=>b.onclick=()=>{note('En la versión final abrirá el chat del chofer libre');$('driversDialog').close();});
 $('driverRows').querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>{note('Edición de WhatsApp por administrador: '+b.dataset.edit);$('driversDialog').close();$('phoneDialog').showModal();});
}
let phoneSaved=false;try{phoneSaved=sessionStorage.getItem('explora-availability-demo-phone')==='yes';}catch{}
if(!phoneSaved)$('phoneDialog').showModal();
 $('phoneForm').onsubmit=e=>{e.preventDefault();const digits=$('phone').value.replace(/\D/g,'');if(digits.length<8||digits.length>12){$('phoneError').textContent='Revisá el número e incluí el código de área.';return;}$('phoneError').textContent='';try{sessionStorage.setItem('explora-availability-demo-phone','yes');}catch{}$('phone').value='';$('phoneDialog').close();note('WhatsApp completado en la demostración; no se guardó el número real');};
 $('skipPhone').onclick=()=>$('phoneDialog').close();$('reset').onclick=()=>$('phoneDialog').showModal();$('change').onclick=()=>{me.free=!me.free;me.number=null;me.zone='';editing=true;render();};$('showDrivers').onclick=()=>{$('driversDialog').showModal();};document.querySelector('.close').onclick=()=>$('driversDialog').close();$('role').onclick=()=>{admin=!admin;$('role').textContent='Vista: '+(admin?'administrador':'chofer');renderPeople();};
document.querySelectorAll('.collection-tool,.bottom button,.logout').forEach(b=>b.onclick=()=>note('Esta demostración se centra en el nuevo menú de disponibilidad'));
render();
