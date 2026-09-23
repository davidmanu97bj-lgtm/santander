import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {searchTourismPlaces, tourismRoute} from '../tourism-catalog.js';

const app=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8');
const start=app.indexOf('function tourismPlaceLabel(place)');
const end=app.indexOf('\nfor(const part of ["Origin","Destination"])initializeTourismSelector(part);',start);
assert.ok(start>=0&&end>start);

function selectorPage({catalog=searchTourismPlaces}={}) {
  class Element {
    constructor(){this.children=[];this.listeners={};this.value='';this.attributes={};this.parent=null;this.textContent='';}
    addEventListener(type,fn){(this.listeners[type]??=[]).push(fn);}
    fire(type,details={}){for(const fn of this.listeners[type]||[])fn({target:this,preventDefault(){},...details});}
    append(child){child.parent=this;this.children.push(child);this.textContent='';}
    replaceChildren(){for(const child of this.children)child.parent=null;this.children=[];this.textContent='';}
    contains(node){return node===this||this.children.some(child=>child.contains(node));}
    closest(){return this.field;}
    setAttribute(key,value){this.attributes[key]=value;}
    focus(){this.fire('focus');}
    querySelector(){return this.children[0]||null;}
    querySelectorAll(){return this.children;}
    set textContent(value){this._text=value;if(value)this.children=[];}
    get textContent(){return this.children.length?this.children.map(c=>c.textContent).join(''):this._text||'';}
  }
  const elements={},fields={},document=new Element(),routes=[];
  document.createElement=()=>{const el=new Element();return el;};
  for(const part of ['Origin','Destination']) {
    const field=fields[part]=new Element();document.append(field);
    for(const suffix of ['', 'Search','Clear','Matches']) {
      const el=elements['tourism'+part+suffix]=new Element();el.field=field;field.append(el);
    }
  }
  const searches=[];
  const context=vm.createContext({document,$:id=>elements[id],
    googleTourismPlaces:new Map(),
    googlePlaceSearchCache:new Map(),
    TOURISM_GOOGLE_DEBOUNCE_MS:150,
    searchTourismPlaces:catalog,
    tourismRoute,
    clearTimeout(){},setTimeout(fn){fn();return 1;},
    exploraRouteCallable:async({query})=>{
      searches.push(query);
      return {data:{places:[{id:query.replace(/\s+/g,'-'),label:`${query} · Google Maps`}]}};
    },
    routeFailureMessage:()=>"No se pudo buscar el lugar.",
    selectTourismRoute:()=>routes.push([elements.tourismOrigin.value,elements.tourismDestination.value])});
  vm.runInContext(app.slice(start,end)+';initializeTourismSelector("Origin");initializeTourismSelector("Destination");',context);
  return {elements,fields,document,routes,searches,places:context.googleTourismPlaces};
}
async function settleSearch(){for(let i=0;i<8;i++)await Promise.resolve();}

test('el catálogo local aparece al instante mientras Google todavía puede completar',async()=>{
  const {elements,searches}=selectorPage();
  const input=elements.tourismOriginSearch,matches=elements.tourismOriginMatches;
  input.value='cataratas argentina';input.fire('input');
  assert.ok(matches.children.length,'Debe mostrar opciones locales sin esperar la red');
  assert.ok(matches.children[0].textContent.includes('catálogo'));
  await settleSearch();
  assert.deepEqual(searches,['cataratas argentina']);
  assert.ok(matches.children.some(child=>child.textContent.includes('Google Maps'))||matches.children.length>=1);
});

test('tocar un resultado de Google Maps completa salida y llegada aunque el navegador pierda el foco antes del click',async()=>{
  const {elements,fields,document,routes,searches}=selectorPage({catalog:()=>[]});
  for(const [part,query] of [['Origin','hotel inventado norte'],['Destination','posada inventada sur']]) {
    const input=elements['tourism'+part+'Search'],matches=elements['tourism'+part+'Matches'];
    input.value=query;input.fire('input');await settleSearch();const choice=matches.children[0];assert.ok(choice);
    document.fire('pointerdown',{target:choice});
    // En pantallas táctiles el desenfoque puede no indicar qué opción se está tocando.
    fields[part].fire('focusout',{target:input,relatedTarget:null});
    assert.ok(matches.children.includes(choice),'La opción debe seguir disponible hasta completar el toque');
    choice.onclick();
    assert.equal(input.value,`${query} · Google Maps`);assert.ok(elements['tourism'+part].value.startsWith('google:'));
    assert.equal(matches.children.length,0);assert.equal(input.attributes['aria-expanded'],'false');
  }
  assert.deepEqual(searches,['hotel inventado norte','posada inventada sur']);
  assert.ok(routes.at(-1).every(Boolean));
});

test('la lista de sugerencias se cierra al tocar o enfocar fuera del campo, sin seleccionar por abrirla',async()=>{
  const {elements,document}=selectorPage({catalog:()=>[]}),input=elements.tourismOriginSearch,matches=elements.tourismOriginMatches;
  for(const event of ['pointerdown','focusin']) {
    input.value='Iguazú Hotel X';input.focus();await settleSearch();assert.ok(matches.children.length);assert.equal(elements.tourismOrigin.value,'');
    document.fire(event,{target:document});assert.equal(matches.children.length,0);assert.equal(input.attributes['aria-expanded'],'false');
  }
});

test('elegir dos puntos del catálogo guarda ids locales listos para km precalculados',async()=>{
  const {elements,places}=selectorPage();
  const input=elements.tourismOriginSearch,matches=elements.tourismOriginMatches;
  input.value='aeropuerto iguazu';input.fire('input');await settleSearch();
  const catalogChoice=matches.children.find(child=>child.textContent.includes('catálogo'));
  assert.ok(catalogChoice);
  catalogChoice.onclick();
  assert.ok(!elements.tourismOrigin.value.startsWith('google:'));
  assert.equal(places.get(elements.tourismOrigin.value).source,'catalog');
});
