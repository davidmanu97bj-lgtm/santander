'use strict';

const {onSchedule} = require('firebase-functions/v2/scheduler');
const {defineSecret} = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const {createFleetShadowSync} = require('./uber-fleet-sync');

// Enabling deployment is a separate prerequisite from the runtime switch.
// An unconfigured deployment does not request, bind or access Uber credentials.
module.exports = ({db}) => {
  const deploymentEnabled = process.env.UBER_FLEET_SYNC_ENABLED === 'true';
  const secrets = deploymentEnabled
    ? [defineSecret('UBER_FLEET_CLIENT_ID'), defineSecret('UBER_FLEET_CLIENT_SECRET')]
    : [];
  const sync = createFleetShadowSync({
    db,
    fetchImpl: (...args) => fetch(...args),
    loadConfig: async () => {
      if (!deploymentEnabled) return {enabled: false};
      const snapshot = await db.collection('uber_fleet_shadow_settings').doc('automatic').get();
      const config = snapshot.data() || {};
      return {enabled: config.enabled === true, organizationId: config.organizationId, startTimeMs: config.startTimeMs};
    },
    loadCredentials: async () => ({clientId: secrets[0]?.value(), clientSecret: secrets[1]?.value()}),
  });
  return {
    uberFleetObserveAutomatically: onSchedule({
      schedule: 'every 5 minutes', timeZone: 'America/Argentina/Buenos_Aires',
      region: 'southamerica-east1', timeoutSeconds: 300, memory: '256MiB',
      maxInstances: 1, concurrency: 1, retryCount: 0, secrets,
    }, async () => {
      // run() persists diagnostic codes; never log rows, routes or credentials.
      const result = await sync.run();
      if(result.errorCode){
        const code=/^UBER_[A-Z0-9_]{1,100}$/.test(result.errorCode)?result.errorCode:'UBER_SYNC_INTERNAL_ERROR';
        logger.warn('Uber Fleet: lectura automática detenida', {code});
        throw new Error(code);
      }
    }),
  };
};
