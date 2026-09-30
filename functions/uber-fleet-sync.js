'use strict';

// Scheduler entry point only. No browser dependency and no financial writes.
const {createHash, randomUUID} = require('node:crypto');
const {createSupplierClient} = require('./uber-fleet-api');

const SYNC_COLLECTIONS = Object.freeze({state: 'uber_fleet_shadow_sync',
  observations: 'uber_fleet_shadow_observations', gaps: 'uber_fleet_shadow_sync_gaps'});
const SYNC_LIMITS = Object.freeze({retentionMs: 86400000, retentionSafetyMs: 300000,
  retentionTriggerMs: 60000, querySafetyMs: 30000,
  lagMs: 300000, overlapMs: 120000, windowMs: 900000, leaseMs: 120000,
  maxRunMs: 240000, maxWindows: 4, maxPages: 20, batchSize: 80,
  observationBytes: 256000, pageBytes: 2500000, maxJsonDepth: 24});
const SAFE_API_CODES = new Set(['UBER_ACCESS_DENIED', 'UBER_UNAUTHORIZED', 'UBER_RATE_LIMITED',
  'UBER_RATE_LIMIT_LOCAL', 'UBER_TIMEOUT', 'UBER_NETWORK_ERROR', 'UBER_HTTP_ERROR',
  'UBER_INVALID_RESPONSE', 'UBER_INVALID_TOKEN_RESPONSE', 'UBER_ORGANIZATION_NOT_AUTHORIZED',
  'UBER_PAGINATION_LOOP', 'UBER_PAGE_LIMIT', 'UBER_CURSOR_INVALID', 'UBER_QUERY_INVALID',
  'UBER_RESPONSE_TOO_LARGE', 'UBER_CONFIG_INVALID']);

class FleetSyncError extends Error {
  constructor(code) {super(code); this.name = 'FleetSyncError'; this.code = code;}
}
const fail = code => {throw new FleetSyncError(code);};
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const syncStateId = organizationId => 'org_' + hash(organizationId);
const idValid = value => typeof value === 'string' && /^[A-Za-z0-9._~+/=-]{1,2048}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const cleanError = error => error instanceof FleetSyncError || SAFE_API_CODES.has(error?.code)
  ? error.code : 'UBER_SYNC_INTERNAL_ERROR';

// Secrets are intentionally absent: supply them via loadCredentials on the server.
function readSyncEnvironment(env = process.env) {
  return {enabled: env.UBER_FLEET_SYNC_ENABLED === 'true',
    organizationId: env.UBER_FLEET_ORGANIZATION_ID || '',
    startTimeMs: /^\d{1,16}$/.test(env.UBER_FLEET_SYNC_START_MS || '') ? Number(env.UBER_FLEET_SYNC_START_MS) : null};
}

function canonical(value, depth = 0) {
  if (depth > SYNC_LIMITS.maxJsonDepth) fail('UBER_SYNC_OBSERVATION_INVALID');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => canonical(item, depth + 1));
  if (object(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    const out = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) fail('UBER_SYNC_OBSERVATION_INVALID');
      out[key] = canonical(value[key], depth + 1);
    }
    return out;
  }
  fail('UBER_SYNC_OBSERVATION_INVALID');
}

function prepareObservation(observation, organizationId) {
  if (!object(observation) || observation.kind !== 'transaction_observation' ||
      observation.source !== 'uber_supplier_api' || observation.mode !== 'shadow' ||
      observation.organizationId !== organizationId || !idValid(observation.transactionId) ||
      !idValid(observation.uberDriverId) || !object(observation.raw) ||
      observation.raw.transactionInfo?.transactionUUID !== observation.transactionId ||
      observation.raw.driverInfo?.driverUUID !== observation.uberDriverId ||
      (observation.tripId !== null && !idValid(observation.tripId)) ||
      (observation.raw.transactionInfo.tripUUID || null) !== observation.tripId) fail('UBER_SYNC_OBSERVATION_INVALID');
  for (const key of ['processedAt', 'description']) {
    if (observation[key] !== null && (typeof observation[key] !== 'string' || observation[key].length > 2048)) fail('UBER_SYNC_OBSERVATION_INVALID');
  }
  const raw = canonical(observation.raw), rawJson = JSON.stringify(raw);
  if (Buffer.byteLength(rawJson, 'utf8') > SYNC_LIMITS.observationBytes) fail('UBER_SYNC_OBSERVATION_TOO_LARGE');
  const sourceHash = hash(raw);
  const id = hash([organizationId, observation.transactionId, sourceHash]);
  // Only transport facts are copied. Injected clients cannot smuggle in a balance,
  // invoice request or Telegram instruction, and no money units are interpreted.
  return {id, sourceHash, kind: 'transaction_observation', source: 'uber_supplier_api', mode: 'shadow',
    isSimulated: true, financialWritesEnabled: false, organizationId,
    transactionId: observation.transactionId, uberDriverId: observation.uberDriverId,
    tripId: observation.tripId, processedAt: observation.processedAt, description: observation.description,
    rawJson, issues: ['UBER_AMOUNTS_UNINTERPRETED']};
}

function createFleetShadowSync({db, fetchImpl, loadConfig = readSyncEnvironment, loadCredentials,
  createClient = createSupplierClient, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), makeRunId = randomUUID} = {}) {
  if (!db?.runTransaction || !db?.collection || typeof loadConfig !== 'function' ||
      typeof createClient !== 'function' || typeof now !== 'function' || typeof sleep !== 'function') fail('UBER_SYNC_CONFIG_INVALID');
  const lockRef = db.collection(SYNC_COLLECTIONS.state).doc('application_lock');
  function clock() {const time = now(); if (!Number.isSafeInteger(time) || time <= 0) fail('UBER_SYNC_CLOCK_INVALID'); return time;}

  async function run() {
    const base = {mode: 'shadow', liveEnabled: false, financialWritesEnabled: false};
    let config;
    try {config = await loadConfig();} catch (_) {return {...base, status: 'blocked', errorCode: 'UBER_SYNC_CONFIG_INVALID'};}
    if (config?.enabled !== true) return {...base, status: 'disabled'};
    let startedAt;
    try {startedAt = clock();} catch (error) {return {...base, status: 'blocked', errorCode: cleanError(error)};}
    if (!idValid(config.organizationId) || !Number.isSafeInteger(config.startTimeMs) ||
        config.startTimeMs <= 0 || config.startTimeMs > startedAt) return {...base, status: 'blocked', errorCode: 'UBER_SYNC_CONFIG_INVALID'};
    if (typeof loadCredentials !== 'function') return {...base, status: 'blocked', errorCode: 'UBER_SYNC_CREDENTIALS_MISSING'};
    const organizationId = config.organizationId;
    const stateRef = db.collection(SYNC_COLLECTIONS.state).doc(syncStateId(organizationId));
    const owner = makeRunId();
    if (!idValid(owner)) return {...base, status: 'blocked', errorCode: 'UBER_SYNC_CONFIG_INVALID'};
    let acquired = false, state, windowsCompleted = 0, observationsSaved = 0, deduplicated = 0;
    function budget() {if (clock() - startedAt >= SYNC_LIMITS.maxRunMs) fail('UBER_SYNC_BUDGET_EXHAUSTED');}
    function checkLease(lock) {if (!lock || lock.owner !== owner || lock.leaseUntilMs <= clock()) fail('UBER_SYNC_LOCK_LOST');}

    async function fenced(update, observationRows = []) {
      budget();
      return db.runTransaction(async tx => {
        const [lockSnap, stateSnap] = await Promise.all([tx.get(lockRef), tx.get(stateRef)]);
        const lock = lockSnap.data(), current = stateSnap.data();
        checkLease(lock);
        if (!current || current.organizationId !== organizationId || current.coverageStartMs !== config.startTimeMs) fail('UBER_SYNC_STATE_INVALID');
        const refs = observationRows.map(row => db.collection(SYNC_COLLECTIONS.observations).doc(row.id));
        const previous = await Promise.all(refs.map(ref => tx.get(ref)));
        const time = clock();
        let saved = 0;
        observationRows.forEach((row, index) => {
          if (previous[index].exists) {
            const existing = previous[index].data();
            if (existing.organizationId !== organizationId || existing.sourceHash !== row.sourceHash ||
                existing.transactionId !== row.transactionId || existing.rawJson !== row.rawJson) fail('UBER_SYNC_OBSERVATION_CONFLICT');
          } else {tx.set(refs[index], {...row, observedAtMs: time}); saved++;}
        });
        const next = {...current, ...update, updatedAtMs: time};
        tx.set(stateRef, next);
        tx.set(lockRef, {...lock, leaseUntilMs: time + SYNC_LIMITS.leaseMs});
        return {state: next, saved, duplicates: observationRows.length - saved};
      });
    }

    async function reserveRequest() {
      while (true) {
        budget();
        const waitMs = await db.runTransaction(async tx => {
          const snap = await tx.get(lockRef), lock = snap.data(); checkLease(lock);
          const time = clock(), wait = Math.max(0, (lock.nextRequestAtMs || 0) - time);
          tx.set(lockRef, {...lock, leaseUntilMs: time + SYNC_LIMITS.leaseMs,
            nextRequestAtMs: wait ? lock.nextRequestAtMs : time + 1100});
          return wait;
        });
        if (!waitMs) return;
        if (waitMs > 5000) fail('UBER_SYNC_RATE_STATE_INVALID');
        await sleep(waitMs);
      }
    }

    async function gapIfNeeded() {
      const retentionFloor = clock() - SYNC_LIMITS.retentionMs;
      // Trigger and landing margins differ. Using the same moving boundary for
      // both creates another tiny gap after every database/network round trip.
      if (state.captureThroughMs >= retentionFloor + SYNC_LIMITS.retentionTriggerMs) return;
      const earliest = retentionFloor + SYNC_LIMITS.retentionSafetyMs;
      budget();
      state = await db.runTransaction(async tx => {
        const [lockSnap, stateSnap] = await Promise.all([tx.get(lockRef), tx.get(stateRef)]);
        const lock = lockSnap.data(), current = stateSnap.data(); checkLease(lock);
        if (current.captureThroughMs !== state.captureThroughMs) fail('UBER_SYNC_STATE_CHANGED');
        const fromMs = current.captureThroughMs, toMs = earliest, time = clock();
        const gapRef = db.collection(SYNC_COLLECTIONS.gaps).doc(hash([organizationId, fromMs, toMs]));
        tx.set(gapRef, {organizationId, mode: 'shadow', status: 'requires_official_report_backfill',
          fromMs, toMs, detectedAtMs: time, reason: 'REALTIME_RETENTION_LIMIT',
          continuousThroughMs: current.continuousThroughMs});
        const next = {...current, captureThroughMs: toMs, recoveryRequired: true,
          oldestGapStartMs: current.oldestGapStartMs ?? fromMs, latestGapEndMs: toMs,
          gapCount: (current.gapCount || 0) + 1, status: 'history_gap', updatedAtMs: time};
        tx.set(stateRef, next); tx.set(lockRef, {...lock, leaseUntilMs: time + SYNC_LIMITS.leaseMs});
        return next;
      });
    }

    try {
      const claim = await db.runTransaction(async tx => {
        const [lockSnap, stateSnap] = await Promise.all([tx.get(lockRef), tx.get(stateRef)]);
        const lock = lockSnap.data(), previous = stateSnap.data(), time = clock();
        if (lock && (!Number.isSafeInteger(lock.leaseUntilMs) || lock.leaseUntilMs < 0 ||
            !Number.isSafeInteger(lock.nextRequestAtMs) || lock.nextRequestAtMs < 0)) fail('UBER_SYNC_LOCK_STATE_INVALID');
        if (lock?.leaseUntilMs > time) return null;
        if (previous && (previous.organizationId !== organizationId || previous.coverageStartMs !== config.startTimeMs ||
            previous.mode !== 'shadow' || typeof previous.recoveryRequired !== 'boolean' ||
            !Number.isSafeInteger(previous.gapCount) || previous.gapCount < 0 ||
            !Number.isSafeInteger(previous.captureThroughMs) || !Number.isSafeInteger(previous.continuousThroughMs) ||
            previous.captureThroughMs < config.startTimeMs || previous.captureThroughMs > time ||
            previous.continuousThroughMs < config.startTimeMs || previous.continuousThroughMs > previous.captureThroughMs ||
            (!previous.recoveryRequired && previous.continuousThroughMs !== previous.captureThroughMs))) fail('UBER_SYNC_STATE_INVALID');
        const initial = previous || {organizationId, mode: 'shadow', coverageStartMs: config.startTimeMs,
          captureThroughMs: config.startTimeMs, continuousThroughMs: config.startTimeMs,
          recoveryRequired: false, gapCount: 0, createdAtMs: time};
        const next = {...initial, status: 'running', updatedAtMs: time, lastAttemptAtMs: time, lastErrorCode: null};
        tx.set(lockRef, {owner, leaseUntilMs: time + SYNC_LIMITS.leaseMs, nextRequestAtMs: lock?.nextRequestAtMs || 0});
        tx.set(stateRef, next); return next;
      });
      if (!claim) return {...base, status: 'busy'};
      acquired = true; state = claim;
      // Record gaps before any network/credential failure can conceal them.
      await gapIfNeeded();
      const credentials = await loadCredentials();
      if (!object(credentials) || typeof credentials.clientId !== 'string' || !credentials.clientId ||
          typeof credentials.clientSecret !== 'string' || !credentials.clientSecret) fail('UBER_SYNC_CREDENTIALS_MISSING');
      const client = createClient({clientId: credentials.clientId, clientSecret: credentials.clientSecret, fetchImpl, now});
      if (!client || typeof client.getOrganizations !== 'function' || typeof client.getRealtimeTransactions !== 'function') fail('UBER_SYNC_CLIENT_INVALID');
      // Scope membership must succeed even when there is currently no new window.
      state = (await fenced({})).state;
      const organizations = await client.getOrganizations();
      if (!Array.isArray(organizations?.organizations) || !organizations.organizations.some(org => org.id === organizationId)) fail('UBER_SYNC_ORGANIZATION_NOT_AUTHORIZED');
      state = (await fenced({apiAccessVerifiedAtMs: clock()})).state;
      const target = clock() - SYNC_LIMITS.lagMs;
      while (state.captureThroughMs < target && windowsCompleted < SYNC_LIMITS.maxWindows) {
        budget(); await gapIfNeeded();
        const frontier = state.captureThroughMs;
        // Re-read recent data for delayed transactions; successful repeats dedupe.
        const startTime = Math.max(config.startTimeMs, frontier - SYNC_LIMITS.overlapMs,
          clock() - SYNC_LIMITS.retentionMs + SYNC_LIMITS.querySafetyMs);
        const endTime = Math.min(startTime + SYNC_LIMITS.windowMs, target);
        if (endTime <= frontier || startTime > frontier) fail('UBER_SYNC_WINDOW_INVALID');
        let cursor, pages = 0;
        const seenCursors = new Set();
        do {
          await reserveRequest();
          const response = await client.getRealtimeTransactions({organizationId, startTime, endTime, ...(cursor ? {cursor} : {})});
          if (!Array.isArray(response?.observations) || response.observations.length > 500 ||
              (response.nextCursor !== null && (typeof response.nextCursor !== 'string' || !response.nextCursor || response.nextCursor.length > 2048))) fail('UBER_SYNC_PAGE_INVALID');
          // Validate the whole page before committing any of its batches.
          const unique = new Map();
          let bytes = 0;
          for (const observation of response.observations) {
            const row = prepareObservation(observation, organizationId);
            bytes += Buffer.byteLength(JSON.stringify(row), 'utf8');
            if (bytes > SYNC_LIMITS.pageBytes) fail('UBER_SYNC_PAGE_TOO_LARGE');
            unique.set(row.id, row);
          }
          deduplicated += response.observations.length - unique.size;
          const prepared = [...unique.values()];
          for (let offset = 0; offset < prepared.length; offset += SYNC_LIMITS.batchSize) {
            const saved = await fenced({}, prepared.slice(offset, offset + SYNC_LIMITS.batchSize));
            state = saved.state; observationsSaved += saved.saved; deduplicated += saved.duplicates;
          }
          if (!prepared.length) state = (await fenced({})).state;
          cursor = response.nextCursor; pages++;
          if (cursor && seenCursors.has(cursor)) fail('UBER_SYNC_PAGINATION_LOOP');
          if (cursor && pages >= SYNC_LIMITS.maxPages) fail('UBER_SYNC_PAGE_LIMIT');
          if (cursor) seenCursors.add(cursor);
        } while (cursor);
        // Never persist an API page cursor. It is instance-bound and ephemeral.
        // Commit the time frontier only after every page is durably observed.
        state = (await fenced({captureThroughMs: endTime,
          continuousThroughMs: state.recoveryRequired ? state.continuousThroughMs : endTime,
          lastCompletedWindow: {startTime, endTime}, lastSuccessAtMs: clock(), lastErrorCode: null})).state;
        windowsCompleted++;
      }
      const status = state.recoveryRequired ? 'history_gap' : state.captureThroughMs >= target ? 'caught_up' : 'catching_up';
      state = (await fenced({status})).state;
      return {...base, status, windowsCompleted, observationsSaved, deduplicated,
        captureThroughMs: state.captureThroughMs, continuousThroughMs: state.continuousThroughMs,
        recoveryRequired: state.recoveryRequired, issues: ['UBER_AMOUNTS_UNINTERPRETED']};
    } catch (error) {
      const errorCode = cleanError(error), status = errorCode === 'UBER_SYNC_BUDGET_EXHAUSTED' ? 'budget_exhausted' : 'blocked';
      if (acquired && errorCode !== 'UBER_SYNC_LOCK_LOST') {
        try {
          await db.runTransaction(async tx => {
            const [lockSnap, stateSnap] = await Promise.all([tx.get(lockRef), tx.get(stateRef)]);
            checkLease(lockSnap.data());
            tx.set(stateRef, {...stateSnap.data(), status, lastErrorCode: errorCode, updatedAtMs: clock()});
          });
        } catch (_) { /* Lost ownership or database failure: never overwrite another run. */ }
      }
      return {...base, status, errorCode, windowsCompleted, observationsSaved, deduplicated,
        recoveryRequired: state?.recoveryRequired ?? false, captureThroughMs: state?.captureThroughMs ?? null,
        continuousThroughMs: state?.continuousThroughMs ?? null};
    } finally {
      if (acquired) {
        try {await db.runTransaction(async tx => {
          const snap = await tx.get(lockRef), lock = snap.data();
          if (lock?.owner === owner) tx.set(lockRef, {...lock, owner: null, leaseUntilMs: 0});
        });} catch (_) { /* Lease expires; never clear another worker's lease. */ }
      }
    }
  }
  return Object.freeze({run});
}

module.exports = {createFleetShadowSync, readSyncEnvironment, syncStateId, FleetSyncError, SYNC_COLLECTIONS, SYNC_LIMITS};
