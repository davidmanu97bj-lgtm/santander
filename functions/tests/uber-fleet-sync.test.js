'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const memoryFirestore = require('./memory-firestore');
const {createFleetShadowSync, readSyncEnvironment, syncStateId, SYNC_COLLECTIONS, SYNC_LIMITS} = require('../uber-fleet-sync');

const NOW = Date.parse('2026-09-29T15:00:00Z');
const ORG = 'authorized-fleet==';
const STATE = `${SYNC_COLLECTIONS.state}/${syncStateId(ORG)}`;
const LOCK = `${SYNC_COLLECTIONS.state}/application_lock`;
const observation = (id = 'transaction-1', amount = 1234567) => ({
  kind: 'transaction_observation', source: 'uber_supplier_api', mode: 'shadow', organizationId: ORG,
  transactionId: id, tripId: 'trip-1', uberDriverId: 'driver-1', processedAt: '2026-09-29T14:45:00Z', description: 'tripCompleteOrder',
  raw: {driverInfo: {driverUUID: 'driver-1'}, transactionInfo: {transactionUUID: id, tripUUID: 'trip-1',
    processedAt: '2026-09-29T14:45:00Z', description: 'tripCompleteOrder',
    breakDown: [{categoryName: 'fare', amount: {amountE5: amount, currencyCode: 'ARS'}}]}},
});
const page = (observations = [observation()], nextCursor = null) => ({observations, nextCursor, issues: ['UBER_AMOUNTS_UNINTERPRETED']});
function setup({db = memoryFirestore(), start = NOW - 20 * 60000, enabled = true, replies = [], next,
  credentials, organizationIds = [ORG], tick = 0} = {}) {
  let time = NOW, credentialCalls = 0, clientCalls = 0;
  const calls = [], waits = [];
  const config = {enabled, organizationId: ORG, startTimeMs: start};
  const now = () => {const result = time; time += tick; return result;};
  const options = {db, now, loadConfig: async () => config,
    loadCredentials: async () => {credentialCalls++; return credentials === undefined ? {clientId: 'synthetic-id', clientSecret: 'synthetic-secret'} : credentials;},
    sleep: async ms => {waits.push(ms); time += ms;},
    createClient: passed => {
      clientCalls++; assert.equal(passed.clientSecret, 'synthetic-secret');
      return {getOrganizations: async () => ({organizations: organizationIds.map(id => ({id}))}),
        getRealtimeTransactions: async query => {calls.push(query); if (next) return next(query, calls.length);
          const response = replies.length ? replies.shift() : page();
          if (response instanceof Error) throw response;
          return response;
        }};
    }};
  const sync = createFleetShadowSync(options);
  return {db, config, options, sync, calls, waits, advance: ms => {time += ms;},
    get credentialCalls() {return credentialCalls;}, get clientCalls() {return clientCalls;}};
}
const observations = db => [...db.data.entries()].filter(([key]) => key.startsWith(SYNC_COLLECTIONS.observations + '/')).map(([, row]) => row);
const gaps = db => [...db.data.entries()].filter(([key]) => key.startsWith(SYNC_COLLECTIONS.gaps + '/')).map(([, row]) => row);

test('environment switch is strictly opt-in; disabled performs no database, credential or API calls', async () => {
  assert.equal(readSyncEnvironment({}).enabled, false);
  assert.equal(readSyncEnvironment({UBER_FLEET_SYNC_ENABLED: 'TRUE'}).enabled, false);
  assert.deepEqual(readSyncEnvironment({UBER_FLEET_SYNC_ENABLED: 'true', UBER_FLEET_ORGANIZATION_ID: ORG, UBER_FLEET_SYNC_START_MS: String(NOW)}),
    {enabled: true, organizationId: ORG, startTimeMs: NOW});
  const h = setup({enabled: false});
  assert.equal((await h.sync.run()).status, 'disabled');
  assert.equal(h.db.data.size, 0); assert.equal(h.credentialCalls, 0); assert.equal(h.calls.length, 0);
});

test('initial coverage must be explicit and cannot be silently reset', async () => {
  const h = setup(); h.config.startTimeMs = null;
  assert.equal((await h.sync.run()).errorCode, 'UBER_SYNC_CONFIG_INVALID');
  assert.equal(h.db.data.size, 0); assert.equal(h.credentialCalls, 0);
  h.config.startTimeMs = NOW - 20 * 60000; await h.sync.run();
  const before = structuredClone(h.db.data.get(STATE));
  h.config.startTimeMs -= 60000;
  assert.equal((await h.sync.run()).errorCode, 'UBER_SYNC_STATE_INVALID');
  assert.deepEqual(h.db.data.get(STATE), before);
});

test('automatic run stores only immutable shadow observations and commits a complete window', async () => {
  const h = setup();
  const result = await h.sync.run();
  assert.equal(result.status, 'caught_up'); assert.equal(result.windowsCompleted, 1);
  assert.equal(result.liveEnabled, false); assert.equal(result.financialWritesEnabled, false);
  assert.equal(result.captureThroughMs, NOW - 5 * 60000);
  assert.equal(result.continuousThroughMs, result.captureThroughMs);
  assert.equal(result.observationsSaved, 1);
  assert.deepEqual(h.calls[0], {organizationId: ORG, startTime: NOW - 20 * 60000, endTime: NOW - 5 * 60000});
  const row = observations(h.db)[0];
  assert.equal(JSON.parse(row.rawJson).transactionInfo.breakDown[0].amount.amountE5, 1234567);
  for (const key of ['amountCents', 'netCents', 'walletDeltaCents', 'invoice', 'payment', 'telegram']) assert.equal(Object.hasOwn(row, key), false);
  assert.ok([...h.db.data.keys()].every(key => Object.values(SYNC_COLLECTIONS).some(collection => key.startsWith(collection + '/'))));
  assert.equal(h.db.data.get(LOCK).owner, null);
});

test('restarts and late data overlap deduplicate observations without overwriting original facts', async () => {
  const h = setup(); await h.sync.run();
  const initial = structuredClone(observations(h.db)[0]);
  h.advance(5 * 60000);
  const result = await createFleetShadowSync(h.options).run();
  assert.equal(result.observationsSaved, 0); assert.equal(result.deduplicated, 1);
  assert.equal(observations(h.db).length, 1);
  assert.deepEqual(observations(h.db)[0], initial);
  assert.equal(h.calls[1].startTime, NOW - 7 * 60000);
});

test('same transaction with changed provider facts is a new observation version, never a new payment', async () => {
  const h = setup({replies: [page([observation()]), page([observation('transaction-1', 7654321)])]});
  await h.sync.run(); h.advance(300000); await h.sync.run();
  const stored = observations(h.db);
  assert.equal(stored.length, 2);
  assert.equal(new Set(stored.map(row => row.transactionId)).size, 1);
  assert.equal(new Set(stored.map(row => row.sourceHash)).size, 2);
});

test('canonical JSON order and repeated rows do not create duplicate observation versions', async () => {
  const one = observation(), two = observation();
  two.raw = {transactionInfo: two.raw.transactionInfo, driverInfo: two.raw.driverInfo};
  const h = setup({replies: [page([one, two, one])]});
  const result = await h.sync.run();
  assert.equal(result.observationsSaved, 1); assert.equal(result.deduplicated, 2);
});

test('pagination failure retains time checkpoint, and restart replays safely from page one', async () => {
  const outage = Object.assign(new Error('provider secret body'), {code: 'UBER_TIMEOUT'});
  const h = setup({replies: [page([observation()], 'cursor-one'), outage,
    page([observation()], 'cursor-restarted'), page([observation('transaction-2')])]});
  const first = await h.sync.run();
  assert.equal(first.errorCode, 'UBER_TIMEOUT');
  assert.equal(first.captureThroughMs, h.config.startTimeMs);
  assert.equal(observations(h.db).length, 1);
  const second = await h.sync.run();
  assert.equal(second.status, 'caught_up');
  assert.equal(observations(h.db).length, 2);
  assert.equal(h.calls[2].cursor, undefined);
  assert.equal(h.calls[0].startTime, h.calls[2].startTime);
  assert.equal(Object.hasOwn(h.db.data.get(STATE), 'cursor'), false);
  assert.ok(h.waits.every(ms => ms > 0 && ms <= 1100));
});

test('a failed observation batch never advances checkpoint; saved earlier batches replay idempotently', async () => {
  const db = memoryFirestore(), original = db.runTransaction;
  let writes = 0, failOnce = true;
  db.runTransaction = fn => original(tx => fn({...tx, set(ref, value, options) {
    if (ref.path.startsWith(SYNC_COLLECTIONS.observations + '/')) {
      writes++;
      if (failOnce && writes === 81) {failOnce = false; throw new Error('private database failure');}
    }
    tx.set(ref, value, options);
  }}));
  const rows = Array.from({length: 161}, (_, i) => observation('transaction-' + i));
  const h = setup({db, next: async () => page(rows)});
  const first = await h.sync.run();
  assert.equal(first.errorCode, 'UBER_SYNC_INTERNAL_ERROR');
  assert.equal(observations(db).length, 80);
  assert.equal(db.data.get(STATE).captureThroughMs, h.config.startTimeMs);
  const second = await h.sync.run();
  assert.equal(second.status, 'caught_up'); assert.equal(observations(db).length, 161);
  assert.ok(second.deduplicated >= 80);
});

test('global lease permits only one polling worker, including concurrent schedulers', async () => {
  let entered, finish;
  const started = new Promise(resolve => {entered = resolve;});
  const pending = new Promise(resolve => {finish = resolve;});
  const h = setup({next: async () => {entered(); return pending;}});
  const first = h.sync.run(); await started;
  const second = await createFleetShadowSync(h.options).run();
  assert.equal(second.status, 'busy'); assert.equal(h.credentialCalls, 1);
  finish(page()); assert.equal((await first).status, 'caught_up');
});

test('lost/expired lease fences stale responses and never releases the new owner lock', async () => {
  let h;
  h = setup({next: async () => {
    h.db.data.set(LOCK, {owner: 'new-worker', leaseUntilMs: NOW + 600000, nextRequestAtMs: NOW + 1100});
    return page();
  }});
  const result = await h.sync.run();
  assert.equal(result.errorCode, 'UBER_SYNC_LOCK_LOST');
  assert.equal(observations(h.db).length, 0);
  assert.equal(h.db.data.get(LOCK).owner, 'new-worker');
  assert.equal(h.db.data.get(STATE).captureThroughMs, h.config.startTimeMs);
});

test('older than 24h becomes a durable explicit gap while recent capture continues', async () => {
  const h = setup({start: NOW - 30 * 3600000, tick: 1});
  const result = await h.sync.run();
  assert.equal(result.status, 'history_gap');
  assert.equal(result.recoveryRequired, true); assert.equal(result.windowsCompleted, 4);
  assert.equal(result.continuousThroughMs, h.config.startTimeMs);
  assert.ok(result.captureThroughMs > NOW - 24 * 3600000);
  assert.equal(gaps(h.db).length, 1);
  assert.equal(gaps(h.db)[0].fromMs, h.config.startTimeMs);
  assert.equal(gaps(h.db)[0].status, 'requires_official_report_backfill');
  for (const query of h.calls) {
    assert.ok(query.startTime >= NOW - 24 * 3600000);
    assert.ok(query.endTime - query.startTime <= 900000);
  }
  // Millisecond drift between the gap transaction and query planning must not
  // create a permanent WINDOW_INVALID loop after a real-world outage.
  assert.equal(result.errorCode, undefined);
});

test('credential failure records overdue gaps without ever connecting or claiming sync success', async () => {
  const h = setup({start: NOW - 30 * 3600000, credentials: {clientId: '', clientSecret: ''}});
  const result = await h.sync.run();
  assert.equal(result.errorCode, 'UBER_SYNC_CREDENTIALS_MISSING');
  assert.equal(result.recoveryRequired, true); assert.equal(gaps(h.db).length, 1);
  assert.equal(h.clientCalls, 0); assert.equal(h.calls.length, 0);
  assert.equal(h.db.data.get(STATE).continuousThroughMs, h.config.startTimeMs);
});

test('unauthorized organization and foreign observation never persist source data', async () => {
  const h = setup({organizationIds: ['other-fleet']});
  assert.equal((await h.sync.run()).errorCode, 'UBER_SYNC_ORGANIZATION_NOT_AUTHORIZED');
  assert.equal(h.calls.length, 0);
  const foreign = setup({replies: [page([observation(), {...observation('x'), organizationId: 'other-fleet'}])]});
  assert.equal((await foreign.sync.run()).errorCode, 'UBER_SYNC_OBSERVATION_INVALID');
  assert.equal(observations(foreign.db).length, 0);
});

test('malformed, oversized or looping pages stop without advancing the checkpoint', async () => {
  const large = observation(); large.raw.note = 'x'.repeat(256001);
  for (const response of [page([large]), {observations: [observation()], nextCursor: undefined}, {observations: [], nextCursor: {}},
    page(Array.from({length: 501}, () => observation()))]) {
    const h = setup({replies: [response]});
    const result = await h.sync.run();
    assert.equal(result.status, 'blocked');
    assert.equal(h.db.data.get(STATE).captureThroughMs, h.config.startTimeMs);
  }
  const loop = setup({next: async () => page([], 'same-cursor')});
  assert.equal((await loop.sync.run()).errorCode, 'UBER_SYNC_PAGINATION_LOOP');
  assert.equal(loop.calls.length, 2);
});

test('bounded runs leave catch-up checkpoint for the next schedule and enforce the page limit', async () => {
  const h = setup({start: NOW - 5 * 3600000, next: async () => page([])});
  assert.equal((await h.sync.run()).status, 'catching_up');
  assert.equal(h.calls.length, 4);
  const many = setup({next: async (_, count) => page([], 'cursor-' + count)});
  assert.equal((await many.sync.run()).errorCode, 'UBER_SYNC_PAGE_LIMIT');
  assert.equal(many.calls.length, 20);
  assert.equal(many.db.data.get(STATE).captureThroughMs, many.config.startTimeMs);
});

test('time budget and corrupt state fail closed without skipping unobserved periods', async () => {
  let h;
  h = setup({next: async () => {h.advance(SYNC_LIMITS.maxRunMs); return page();}});
  assert.equal((await h.sync.run()).status, 'budget_exhausted');
  assert.equal(observations(h.db).length, 0);
  const corrupt = setup(); await corrupt.sync.run();
  corrupt.db.data.get(STATE).continuousThroughMs = -1;
  assert.equal((await corrupt.sync.run()).errorCode, 'UBER_SYNC_STATE_INVALID');
});

test('errors and return values contain no credentials, tokens, payloads or raw upstream messages', async () => {
  const h = setup({next: async () => {throw new Error('synthetic-secret token private-data https://private.test');}});
  const result = await h.sync.run();
  assert.equal(result.errorCode, 'UBER_SYNC_INTERNAL_ERROR');
  assert.doesNotMatch(JSON.stringify(result) + JSON.stringify(h.db.data.get(STATE)), /synthetic-secret|private-data|private\.test/);
});

test('integration with the actual Supplier adapter uses injected fetch only and obeys its cursor/rate contract', async () => {
  const h = setup(), urls = [];
  const options = {...h.options}; delete options.createClient;
  options.fetchImpl = async (url, request) => {
    urls.push(url);
    let body;
    if (url === 'https://auth.uber.com/oauth/v2/token') {
      body = {access_token: 'synthetic-token', token_type: 'Bearer', expires_in: 3600,
        scope: new URLSearchParams(request.body).get('scope')};
    } else if (new URL(url).pathname.endsWith('/orgs')) {
      body = {organizations: [{id: ORG, name: 'Synthetic', types: ['DRIVER_BUSINESS']}]};
    } else {
      assert.equal(new URL(url).pathname, '/v1/vehicle-suppliers/transactions');
      const pageToken = JSON.parse(request.body).pagination_options.pageToken;
      body = {statusCode: 200, body: {transactions: [observation(pageToken ? 'transaction-2' : 'transaction-1').raw],
        paginationResult: {nextPageToken: pageToken ? '' : 'provider-page-two'}}};
    }
    return new Response(JSON.stringify(body), {status: 200});
  };
  const result = await createFleetShadowSync(options).run();
  assert.equal(result.status, 'caught_up'); assert.equal(result.observationsSaved, 2);
  assert.equal(urls.filter(url => new URL(url).pathname.endsWith('/transactions')).length, 2);
  assert.ok(urls.every(url => ['api.uber.com', 'auth.uber.com'].includes(new URL(url).hostname)));
  assert.deepEqual(h.waits, [1100]);
});
