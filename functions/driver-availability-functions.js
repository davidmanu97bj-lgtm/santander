"use strict";

const {onCall,HttpsError}=require('firebase-functions/v2/https');
const {onDocumentWritten,onDocumentCreated}=require('firebase-functions/v2/firestore');
const {onSchedule}=require('firebase-functions/v2/scheduler');

// Keep deployed names as inert retirement handlers. No reads, writes or messages:
// historical documents remain intact and old clients cannot change availability.
module.exports=()=>{
 const region='southamerica-east1';
 const options={region,timeoutSeconds:60,maxInstances:10};
 const retired=()=>{throw new HttpsError('failed-precondition','La disponibilidad y la adjudicación de números ya no están disponibles. Actualizá la aplicación.');};
 const ignore=()=>null;
 return {
  availabilityBootstrap:onCall(options,retired),
  availabilitySavePhone:onCall(options,retired),
  availabilityChange:onCall(options,retired),
  availabilityDriverSync:onDocumentWritten({region,document:'choferes/{uid}',retry:true},ignore),
  availabilityUserSync:onDocumentWritten({region,document:'usuarios/{uid}',retry:true},ignore),
  availabilityMidnight:onSchedule({region,schedule:'0 0 * * *',timeZone:'America/Argentina/Buenos_Aires',retryCount:3},ignore),
  availabilityTelegram:onDocumentCreated({region:'us-central1',document:'driver_availability_events/{id}',retry:true,timeoutSeconds:60},ignore)
 };
};
