import {test} from 'node:test';
import assert from 'node:assert/strict';
import {tourismCatalog as c,tourismRoute} from '../tourism-catalog.js';
test('catálogo: seis ciudades, identificadores únicos y matriz completa de ida y vuelta',()=>{
 assert.equal(new Set(c.places.map(p=>p.city)).size,6);
 assert.equal(new Set(c.places.map(p=>p.id)).size,c.places.length);
 assert.equal(c.distances.length,c.places.length);
 let count=0;
 for(let i=0;i<c.places.length;i++){
  assert.equal(c.distances[i].length,c.places.length);
  for(let j=0;j<c.places.length;j++){
   if(i===j){assert.equal(tourismRoute(c.places[i].id,c.places[j].id),null);continue;}
   const route=tourismRoute(c.places[i].id,c.places[j].id);
   assert.ok(route.distance>0 && route.distance<20000);
   assert.equal(route.origin.id,c.places[i].id);assert.equal(route.destination.id,c.places[j].id);
   count++;
  }
 }
 assert.equal(count,1640);
});
test('catálogo: conserva la medición comprobada aeropuerto-terminal y rechaza opciones inválidas',()=>{
 const airport=c.places.find(p=>p.name==='Aeropuerto Internacional de Puerto Iguazú');
 const terminal=c.places.find(p=>p.name==='Terminal de Ómnibus de Puerto Iguazú');
 assert.equal(tourismRoute(airport.id,terminal.id).distance,20.2);
 assert.equal(tourismRoute('missing',terminal.id),null);
 assert.equal(tourismRoute(airport.id,''),null);
});
