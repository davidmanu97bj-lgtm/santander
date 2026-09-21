"use strict";
const {onCall}=require('firebase-functions/v2/https');
const {onDocumentWritten,onDocumentCreated}=require('firebase-functions/v2/firestore');
const {onSchedule}=require('firebase-functions/v2/scheduler');
const {createAvailabilityService}=require('./driver-availability');
module.exports=({db,secrets,notify})=>{
 const service=createAvailabilityService({db}),region='southamerica-east1';
 const options={region,timeoutSeconds:60,maxInstances:10};
 const sync=event=>service.syncDriver(event.params.uid);
 return {
  availabilityBootstrap:onCall(options,request=>service.bootstrap(request)),
  availabilitySavePhone:onCall(options,request=>service.savePhone(request)),
  availabilityChange:onCall(options,request=>service.change(request)),
  availabilityDriverSync:onDocumentWritten({region,document:'choferes/{uid}',retry:true},sync),
  availabilityUserSync:onDocumentWritten({region,document:'usuarios/{uid}',retry:true},sync),
  availabilityMidnight:onSchedule({region,schedule:'0 0 * * *',timeZone:'America/Argentina/Buenos_Aires',retryCount:3},()=>service.ensureDay()),
  availabilityTelegram:onDocumentCreated({region:'us-central1',document:'driver_availability_events/{id}',secrets,retry:true,timeoutSeconds:60},async event=>{
   const data=event.data?.data();if(!data?.notify)return;
   return notify({kind:'availability',docId:event.params.id,sourceCollection:'driver_availability_events',data:{},eventId:event.id,caption:data.text,requirePhoto:false});
  })
 };
};
