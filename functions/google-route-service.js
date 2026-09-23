"use strict";
const {RouteError,validateRouteRequest}=require('./route-service');
const {summarizeGooglePlace}=require('./address-summary');
const CENTER={latitude:-25.5972,longitude:-54.5736};
function haversineKm(point){
  if(!Array.isArray(point)||point.length!==2||!point.every(Number.isFinite)||Math.abs(point[0])>180||Math.abs(point[1])>90)return Infinity;
  const rad=n=>n*Math.PI/180;
  const a=Math.sin(rad(point[1]-CENTER.latitude)/2)**2+Math.cos(rad(CENTER.latitude))*Math.cos(rad(point[1]))*Math.sin(rad(point[0]-CENTER.longitude)/2)**2;
  return 6371*2*Math.atan2(Math.sqrt(a),Math.sqrt(Math.max(0,1-a)));
}
function withinArea(point){return haversineKm(point)<=100;}
function normalizeRegionText(value){
  return String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
}
// Region buckets for Salida/Llegada: majority of trips start in Puerto Iguazú.
// 0 = AR Iguazú, 1 = BR Foz, 2 = Paraguay, 3 = other (Wanda, Libertad, etc.).
function tourismRegionBucket({country,label,locality,distanceKm}){
  const text=normalizeRegionText([label,locality].filter(Boolean).join(' '));
  const code=String(country||'').toUpperCase();
  const nearIguazu=Number.isFinite(distanceKm)&&distanceKm<=18;
  if((code==='AR'||code==='ARG')&&(/\biguaz|\bpuerto iguaz/.test(text)||nearIguazu))return 0;
  if(code==='BR'||code==='BRA'||/\bfoz\b|\biguacu\b/.test(text))return 1;
  if(code==='PY'||code==='PRY'||/\bparaguay|\bciudad del este|\bhernandarias/.test(text))return 2;
  return 3;
}
function softDistanceScore(distanceKm){
  if(!Number.isFinite(distanceKm))return 1e6;
  // Soft demotion past ~45 km so distant AR/BR/PY do not float above nearby matches.
  return distanceKm+(distanceKm>45?distanceKm-45:0)+(distanceKm>70?(distanceKm-70)*2:0);
}
function rankTourismPlaces(places){
  return [...places].map((place,index)=>{
    const distanceKm=Number.isFinite(place.distanceKm)?place.distanceKm:haversineKm(place.coordinates);
    const region=tourismRegionBucket({...place,distanceKm});
    return {place:{...place,distanceKm:Math.round(distanceKm*10)/10},region,distanceScore:softDistanceScore(distanceKm),index};
  }).sort((a,b)=>a.region-b.region||a.distanceScore-b.distanceScore||a.index-b.index)
    .map(item=>item.place);
}
async function queryGoogleRoute(data,key,fetcher=fetch){
  const request=validateRouteRequest(data),search=request.action==='search';
  if(!key)throw new RouteError('failed-precondition','Google Maps todavía no está conectado. Podés elegir uno de los lugares de la lista.');
  if(!search&&(!withinArea(request.origin)||!withinArea(request.destination)))throw new RouteError('invalid-argument','Elegí lugares dentro de los 100 km de Puerto Iguazú.');
  const endpoint=search?'https://places.googleapis.com/v1/places:searchText':'https://routes.googleapis.com/directions/v2:computeRoutes';
  const waypoint=p=>({location:{latLng:{latitude:p[1],longitude:p[0]}}});
  const body=search?{textQuery:request.query,languageCode:'es',pageSize:20,locationRestriction:{rectangle:{low:{latitude:-26.51,longitude:-55.58},high:{latitude:-24.68,longitude:-53.56}}}}:{origin:waypoint(request.origin),destination:waypoint(request.destination),travelMode:'DRIVE',routingPreference:'TRAFFIC_UNAWARE'};
  let response;
  try{response=await fetcher(endpoint,{method:'POST',headers:{'Content-Type':'application/json','X-Goog-Api-Key':key,'X-Goog-FieldMask':search?'places.id,places.displayName,places.formattedAddress,places.location,places.addressComponents,places.attributions':'routes.distanceMeters'},body:JSON.stringify(body),signal:AbortSignal.timeout(12000)});}catch{throw new RouteError('unavailable','No pudimos conectar con Google Maps. Reintentá.');}
  if(!response.ok)throw new RouteError(response.status===429?'resource-exhausted':response.status===403?'failed-precondition':'unavailable',response.status===403?'Falta habilitar Google Maps en la cuenta de Explora.':'Google Maps no está disponible en este momento.');
  let result;try{result=await response.json();}catch{throw new RouteError('unavailable','Google Maps devolvió una respuesta inválida.');}
  if(search){
    const places=(Array.isArray(result.places)?result.places:[]).flatMap(place=>{
      const point=[place.location?.longitude,place.location?.latitude];
      const country=place.addressComponents?.find(c=>c.types?.includes('country'))?.shortText;
      const locality=place.addressComponents?.find(c=>c.types?.includes('locality')||c.types?.includes('postal_town')||c.types?.includes('administrative_area_level_2'))?.longText||'';
      if(!withinArea(point)||!['AR','BR','PY'].includes(country)||!place.id)return [];
      const label=summarizeGooglePlace(place).slice(0,300);
      const distanceKm=haversineKm(point);
      return label?[{id:place.id,label,coordinates:point,country,locality,distanceKm,source:'google',attributions:place.attributions||[]}]:[];
    });
    return {places:rankTourismPlaces(places).slice(0,8),source:'google'};
  }
  const meters=result.routes?.[0]?.distanceMeters;
  if(!Number.isFinite(meters)||meters<=0||meters>20000000)throw new RouteError('not-found','No encontramos un recorrido entre esos lugares.');
  return {distanceKm:Math.max(.1,Math.round(meters/100)/10),source:'google',calculatedAt:new Date().toISOString()};
}
module.exports={queryGoogleRoute,withinArea,haversineKm,tourismRegionBucket,softDistanceScore,rankTourismPlaces};
