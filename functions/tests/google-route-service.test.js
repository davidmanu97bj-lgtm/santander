'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {queryGoogleRoute,withinArea,rankTourismPlaces,tourismRegionBucket}=require('../google-route-service');
test('Google: devuelve solo lugares dentro de 100 km y protege la clave',async()=>{
  const place=(id,lat,country='AR')=>({id,displayName:{text:id},location:{latitude:lat,longitude:-54.5736},addressComponents:[{types:['country'],shortText:country}]});
  const result=await queryGoogleRoute({action:'search',query:'hotel'},'test-only',async(url,options)=>{
    assert.equal(url,'https://places.googleapis.com/v1/places:searchText');assert.equal(options.headers['X-Goog-Api-Key'],'test-only');assert.ok(!url.includes('test-only'));
    assert.ok(JSON.parse(options.body).locationRestriction.rectangle);
    return {ok:true,json:async()=>({places:[place('Local',-25.6),place('Brasil',-25.55,'BR'),place('Paraguay',-25.55,'PY'),place('Lejano',-27),place('Inválido',200)]})};
  });
  assert.deepEqual(result.places.map(p=>p.id),['Local','Brasil','Paraguay']);
});
test('Google: prioriza Iguazú > Foz > Paraguay y demota lejanos',async()=>{
  const place=(id,lat,lon,country,locality)=>({
    id,
    displayName:{text:id},
    location:{latitude:lat,longitude:lon},
    addressComponents:[
      {types:['country'],shortText:country},
      ...(locality?[{types:['locality'],longText:locality}]:[])
    ]
  });
  // Google-like order: Foz hotel first, then Paraguay, then distant Wanda, then Iguazú.
  const result=await queryGoogleRoute({action:'search',query:'hotel'},'test-only',async()=>({ok:true,json:async()=>({places:[
    place('Hotel Foz',-25.547,-54.588,'BR','Foz do Iguaçu'),
    place('Hotel Este',-25.509,-54.611,'PY','Ciudad del Este'),
    place('Hotel Wanda',-25.970,-54.560,'AR','Wanda'),
    place('Hotel Iguazú',-25.597,-54.575,'AR','Puerto Iguazú'),
  ]})}));
  assert.deepEqual(result.places.map(p=>p.id),['Hotel Iguazú','Hotel Foz','Hotel Este','Hotel Wanda']);
  assert.equal(result.places[0].country,'AR');
  assert.ok(result.places.every(p=>Number.isFinite(p.distanceKm)));
});
test('Google: filtro circular incluye 99 km y excluye 101 km',()=>{
  assert.equal(withinArea([-54.5736,-25.5972+99/6371*180/Math.PI]),true);
  assert.equal(withinArea([-54.5736,-25.5972+101/6371*180/Math.PI]),false);
});
test('rankTourismPlaces ordena por región y distancia suave',()=>{
  const ranked=rankTourismPlaces([
    {id:'py',country:'PY',label:'Duty Free Este',coordinates:[-54.61,-25.51]},
    {id:'foz',country:'BR',label:'Hotel Foz',locality:'Foz do Iguaçu',coordinates:[-54.588,-25.547]},
    {id:'wanda',country:'AR',label:'Wanda',locality:'Wanda',coordinates:[-54.56,-25.97]},
    {id:'iguazu',country:'AR',label:'Hotel centro',locality:'Puerto Iguazú',coordinates:[-54.575,-25.597]},
  ]);
  assert.deepEqual(ranked.map(p=>p.id),['iguazu','foz','py','wanda']);
  assert.equal(tourismRegionBucket({country:'AR',label:'Puerto Iguazú',distanceKm:2}),0);
  assert.equal(tourismRegionBucket({country:'BR',label:'Foz',distanceKm:8}),1);
  assert.equal(tourismRegionBucket({country:'PY',label:'Este',distanceKm:12}),2);
});
test('Google: no consulta sin clave ni con puntos fuera del radio',async()=>{
  const never=()=>assert.fail('No debe contactar al proveedor');
  await assert.rejects(queryGoogleRoute({action:'search',query:'hotel'},'',never),{code:'failed-precondition'});
  await assert.rejects(queryGoogleRoute({action:'route',origin:[-54.57,-25.6],destination:[-58,-34]},'test',never),{code:'invalid-argument'});
});
test('Google: kilómetros reales de ruta y errores sin datos ficticios',async()=>{
  const input={action:'route',origin:[-54.57,-25.6],destination:[-54.58,-25.61]};
  const result=await queryGoogleRoute(input,'test',async(url,options)=>{
    assert.equal(JSON.parse(options.body).origin.location.latLng.longitude,-54.57);
    return {ok:true,json:async()=>({routes:[{distanceMeters:12345}]})};
  });assert.equal(result.distanceKm,12.3);
  await assert.rejects(queryGoogleRoute(input,'test',async()=>({ok:false,status:403})),{code:'failed-precondition'});
  await assert.rejects(queryGoogleRoute(input,'test',async()=>({ok:false,status:429})),{code:'resource-exhausted'});
  await assert.rejects(queryGoogleRoute(input,'test',async()=>({ok:true,json:async()=>({routes:[]})})),{code:'not-found'});
});
