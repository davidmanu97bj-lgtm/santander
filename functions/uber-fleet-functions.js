"use strict";
const {onCall,HttpsError}=require('firebase-functions/v2/https');
const {createFleetShadowService,FleetServiceError}=require('./uber-fleet-service');
module.exports=({db,assertAdmin})=>{
  const service=createFleetShadowService({db,assertAdmin});
  const callable=method=>onCall({region:'southamerica-east1',timeoutSeconds:120,memory:'512MiB',maxInstances:2},async request=>{
    try{return await service[method](request);}
    catch(error){
      if(error instanceof HttpsError)throw error;
      if(error instanceof FleetServiceError)throw new HttpsError(error.code,error.message);
      // Never return file contents, credentials, or underlying Firestore errors.
      throw new HttpsError('failed-precondition','No se pudo comparar el reporte. Revisá su formato y volvé a intentar.');
    }
  });
  return {uberFleetStatus:callable('status'),uberFleetAnalyze:callable('analyze'),uberFleetTemplates:callable('templates')};
};
