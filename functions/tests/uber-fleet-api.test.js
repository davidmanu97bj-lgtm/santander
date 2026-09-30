'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createHmac} = require('node:crypto');
const {createSupplierClient, verifySupplierWebhookSignature, SupplierApiError, SUPPLIER_SCOPES} = require('../uber-fleet-api');

const NOW = Date.parse('2026-09-29T12:00:00Z');
const QUERY = {organizationId: 'fleet_org==', startTime: NOW - 20 * 60000, endTime: NOW - 10 * 60000};
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {status, headers});
const orgs = [{id: QUERY.organizationId, name: 'Flota ficticia', types: ['DRIVER_BUSINESS']}];
const row = () => ({driverInfo: {driverUUID: 'driver-1', firstName: 'Ficticio'},
  transactionInfo: {transactionUUID: 'tx-1', tripUUID: 'trip-1', processedAt: '2026-09-29T11:45:00Z',
    description: 'tripCompleteOrder', breakDown: [{categoryName: 'fare', amount: {amountE5: 12345000, currencyCode: 'ARS'}}]}});
const page = (nextPageToken = '', transactions = [row()]) => ({transactions, paginationResult: {nextPageToken}});

function setup({responses = [], organizationResponse, tokenResponse, fetchOverride, timeoutMs} = {}) {
  let time = NOW;
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({url, options});
    if (fetchOverride) return fetchOverride(url, options);
    if (url === 'https://auth.uber.com/oauth/v2/token') {
      const form = new URLSearchParams(options.body);
      return json(tokenResponse || {access_token: 'synthetic-token', token_type: 'Bearer', expires_in: 3600, scope: form.get('scope')});
    }
    if (url === 'https://api.uber.com/v1/vehicle-suppliers/orgs') return json(organizationResponse || {organizations: orgs});
    assert.equal(new URL(url).pathname, '/v1/vehicle-suppliers/transactions');
    const next = responses.length ? responses.shift() : page();
    return next instanceof Response ? next : json(next);
  };
  const client = createSupplierClient({clientId: 'synthetic-client', clientSecret: 'synthetic-secret', fetchImpl, now: () => time, timeoutMs});
  return {client, calls, advance: ms => {time += ms;}};
}

test('construction is inert, requires injected transport and does not read environment credentials', () => {
  assert.throws(() => createSupplierClient({clientId: 'a', clientSecret: 'b'}), {code: 'UBER_CONFIG_INVALID'});
  const h = setup();
  assert.equal(h.calls.length, 0);
  assert.deepEqual(Object.keys(h.client).sort(), ['getOrganizations', 'getRealtimeTransactions']);
  assert.equal(Object.isFrozen(h.client), true);
});

test('authorized organizations use fixed official URLs, minimum scope, hidden tokens and no redirects', async () => {
  const {client, calls} = setup();
  assert.deepEqual(await client.getOrganizations(), {organizations: [{id: QUERY.organizationId, parentOrganizationId: null, name: 'Flota ficticia', types: ['DRIVER_BUSINESS']}]});
  const form = new URLSearchParams(calls[0].options.body);
  assert.equal(form.get('grant_type'), 'client_credentials');
  assert.equal(form.get('scope'), SUPPLIER_SCOPES.organizations);
  assert.equal(form.get('client_secret'), 'synthetic-secret');
  assert.equal(calls[1].options.method, 'GET');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer synthetic-token');
  for (const call of calls) {
    assert.equal(call.options.redirect, 'error');
    assert.ok(call.options.signal instanceof AbortSignal);
    assert.ok(['auth.uber.com', 'api.uber.com'].includes(new URL(call.url).hostname));
  }
});

test('transactions return observations only; money is unchanged and never called gross, net or settled', async () => {
  const raw = row();
  raw.transactionInfo.breakDowns = [{amount: {amountES: 777, currencyCode: 'ARS'}}];
  const {client, calls} = setup({responses: [{statusCode: 200, body: page('', [raw])}]});
  const result = await client.getRealtimeTransactions(QUERY);
  assert.deepEqual(result.issues, ['UBER_AMOUNTS_UNINTERPRETED']);
  assert.equal(result.nextCursor, null);
  assert.deepEqual(result.observations[0], {kind: 'transaction_observation', source: 'uber_supplier_api', mode: 'shadow',
    organizationId: QUERY.organizationId, transactionId: 'tx-1', tripId: 'trip-1', uberDriverId: 'driver-1',
    processedAt: '2026-09-29T11:45:00Z', description: 'tripCompleteOrder', raw});
  for (const key of ['amount', 'gross', 'net', 'commission', 'invoice', 'payment', 'completedAt']) assert.equal(Object.hasOwn(result.observations[0], key), false);
  const request = calls.at(-1);
  assert.equal(new URL(request.url).searchParams.get('org_id'), QUERY.organizationId);
  assert.deepEqual(JSON.parse(request.options.body), {
    filters: [{field: 'timeRange', operator: 'FILTER_OPERATOR_IN_RANGE', value: [String(QUERY.startTime), String(QUERY.endTime)]}],
    sort: [{field: 'processedAt', direction: 'DIRECTION_ASCENDING'}], pagination_options: {pageSize: 500, pageToken: ''},
  });
  assert.equal(new URLSearchParams(calls[2].options.body).get('scope'), SUPPLIER_SCOPES.transactions);
});

test('unrelated organizations cannot request financial data and URL input cannot become an endpoint', async () => {
  const {client, calls} = setup();
  await assert.rejects(client.getRealtimeTransactions({...QUERY, organizationId: 'foreign-org'}), {code: 'UBER_ORGANIZATION_NOT_AUTHORIZED'});
  assert.equal(calls.length, 2);
  await assert.rejects(client.getRealtimeTransactions({...QUERY, organizationId: 'https://attacker.test/path'}), {code: 'UBER_QUERY_INVALID'});
  assert.equal(calls.length, 2);
});

test('queries outside explicit documented time bounds fail before network', async () => {
  const {client, calls} = setup();
  for (const change of [{startTime: NOW - 86400001}, {endTime: NOW + 1}, {endTime: QUERY.startTime},
    {startTime: QUERY.endTime - 900001}, {startTime: '2026-09-29T11:40:00Z'}, {startTime: NaN}]) {
    await assert.rejects(client.getRealtimeTransactions({...QUERY, ...change}), {code: 'UBER_QUERY_INVALID'});
  }
  assert.equal(calls.length, 0);
});

test('pagination uses opaque instance-bound cursors, keeps query binding and rejects replays', async () => {
  const h = setup({responses: [page('provider-token'), page('', [])]});
  const first = await h.client.getRealtimeTransactions(QUERY);
  assert.notEqual(first.nextCursor, 'provider-token');
  await assert.rejects(h.client.getRealtimeTransactions({...QUERY, cursor: 'provider-token'}), {code: 'UBER_CURSOR_INVALID'});
  await assert.rejects(h.client.getRealtimeTransactions({...QUERY, endTime: QUERY.endTime + 1, cursor: first.nextCursor}), {code: 'UBER_CURSOR_INVALID'});
  await assert.rejects(setup().client.getRealtimeTransactions({...QUERY, cursor: first.nextCursor}), {code: 'UBER_CURSOR_INVALID'});
  h.advance(1000);
  const last = await h.client.getRealtimeTransactions({...QUERY, cursor: first.nextCursor});
  assert.equal(last.nextCursor, null);
  assert.deepEqual(last.observations, []);
  assert.equal(JSON.parse(h.calls.at(-1).options.body).pagination_options.pageToken, 'provider-token');
  await assert.rejects(h.client.getRealtimeTransactions({...QUERY, cursor: first.nextCursor}), {code: 'UBER_CURSOR_INVALID'});
});

test('pagination rejects loops, excessive pages, expired cursors and oversized provider tokens', async () => {
  const loop = setup({responses: [page('same'), page('same')]});
  const first = await loop.client.getRealtimeTransactions(QUERY);
  loop.advance(1000);
  await assert.rejects(loop.client.getRealtimeTransactions({...QUERY, cursor: first.nextCursor}), {code: 'UBER_PAGINATION_LOOP'});
  const expired = setup({responses: [page('token')]});
  const exp = await expired.client.getRealtimeTransactions(QUERY);
  expired.advance(600001);
  await assert.rejects(expired.client.getRealtimeTransactions({...QUERY, cursor: exp.nextCursor}), {code: 'UBER_CURSOR_INVALID'});
  const many = setup({responses: Array.from({length: 20}, (_, i) => page('page-' + i))});
  let cursor;
  for (let i = 0; i < 19; i++) {
    const result = await many.client.getRealtimeTransactions({...QUERY, cursor});
    cursor = result.nextCursor;
    many.advance(1000);
  }
  await assert.rejects(many.client.getRealtimeTransactions({...QUERY, cursor}), {code: 'UBER_PAGE_LIMIT'});
  await assert.rejects(setup({responses: [page('x'.repeat(2049))]}).client.getRealtimeTransactions(QUERY), {code: 'UBER_INVALID_RESPONSE'});
});

test('local transaction rate limit prevents simultaneous calls; no automatic retries occur', async () => {
  const h = setup();
  await h.client.getRealtimeTransactions(QUERY);
  const count = h.calls.length;
  await assert.rejects(h.client.getRealtimeTransactions(QUERY), {code: 'UBER_RATE_LIMIT_LOCAL', retryAfterMs: 1000});
  assert.equal(h.calls.length, count);
  h.advance(1000);
  await h.client.getRealtimeTransactions(QUERY);
  assert.equal(h.calls.length, count + 1);
});

test('organization permissions are refreshed after one minute and denials invalidate cursors', async () => {
  const organizationResponse = {organizations: [...orgs]};
  const h = setup({organizationResponse, responses: [page('token')]});
  const first = await h.client.getRealtimeTransactions(QUERY);
  h.advance(60000);
  organizationResponse.organizations = [];
  await assert.rejects(h.client.getRealtimeTransactions({...QUERY, cursor: first.nextCursor}), {code: 'UBER_ORGANIZATION_NOT_AUTHORIZED'});
  assert.equal(h.calls.filter(call => new URL(call.url).pathname.endsWith('/transactions')).length, 1);
});

test('upstream and authentication errors expose only static codes, never credentials or payloads', async () => {
  const errorBody = {access_token: 'private-token', message: 'synthetic-secret account email'};
  for (const status of [302, 400, 401, 403, 429, 500]) {
    const h = setup({fetchOverride: async () => json(errorBody, status)});
    await assert.rejects(h.client.getOrganizations(), error => {
      assert.ok(error instanceof SupplierApiError);
      assert.equal(error.status, status);
      assert.doesNotMatch(String(error) + JSON.stringify(error), /synthetic-secret|private-token|email|https:/);
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(h.calls.length, 1);
  }
  const h = setup({fetchOverride: async () => {throw new Error('synthetic-secret token synthetic-token');}});
  await assert.rejects(h.client.getOrganizations(), {code: 'UBER_NETWORK_ERROR', message: 'UBER_NETWORK_ERROR'});
});

test('token scope and shape must match; tokens are cached and expire without exposing refresh tokens', async () => {
  for (const tokenResponse of [
    {access_token: 'token', token_type: 'Bearer', expires_in: 3600, scope: 'unrelated'},
    {access_token: 'token\r\nheader', token_type: 'Bearer', expires_in: 3600, scope: SUPPLIER_SCOPES.organizations},
    {access_token: 'token', token_type: {}, expires_in: 3600, scope: SUPPLIER_SCOPES.organizations},
  ]) await assert.rejects(setup({tokenResponse}).client.getOrganizations(), {code: 'UBER_INVALID_TOKEN_RESPONSE'});
  const h = setup();
  await h.client.getOrganizations();
  await h.client.getOrganizations();
  assert.equal(h.calls.filter(call => call.url.includes('/oauth/')).length, 1);
  h.advance(3600000);
  await h.client.getOrganizations();
  assert.equal(h.calls.filter(call => call.url.includes('/oauth/')).length, 2);
});

test('declared and streaming response sizes are capped before parsing', async () => {
  for (const response of [json({}, 200, {'content-length': String(2 * 1024 * 1024 + 1)}),
    new Response('x'.repeat(2 * 1024 * 1024 + 1))]) {
    await assert.rejects(setup({fetchOverride: async () => response}).client.getOrganizations(), {code: 'UBER_RESPONSE_TOO_LARGE'});
  }
});

test('timeouts abort both a stalled transport and a stalled response body', async () => {
  for (const bodyStall of [false, true]) {
    let signal;
    const h = setup({timeoutMs: 15, fetchOverride: async (_, options) => {
      signal = options.signal;
      return bodyStall ? new Response(new ReadableStream({start() {}})) : new Promise(() => {});
    }});
    await assert.rejects(h.client.getOrganizations(), {code: 'UBER_TIMEOUT'});
    assert.equal(signal.aborted, true);
  }
});

test('malformed pages never silently skip transactions or substitute missing IDs', async () => {
  for (const response of [page('', Array.from({length: 501}, row)), page('', [{}]),
    {...page(), paginationResult: {}}, {statusCode: 500, body: page()},
    page('', [{...row(), transactionInfo: {...row().transactionInfo, transactionUUID: ''}}])]) {
    await assert.rejects(setup({responses: [response]}).client.getRealtimeTransactions(QUERY), {code: 'UBER_INVALID_RESPONSE'});
  }
  const noTrip = row();
  delete noTrip.transactionInfo.tripUUID;
  assert.equal((await setup({responses: [page('', [noTrip])]}).client.getRealtimeTransactions(QUERY)).observations[0].tripId, null);
});

test('webhook HMAC validates raw bytes only, including whitespace and backslashes', () => {
  const rawBody = Buffer.from('{"event_id":"synthetic", "value":"a\\\\b"}');
  const clientSecret = 'synthetic-secret';
  const signature = createHmac('sha256', clientSecret).update(rawBody).digest('hex');
  assert.equal(verifySupplierWebhookSignature({rawBody, signature, clientSecret}), true);
  assert.equal(verifySupplierWebhookSignature({rawBody, signature: signature.toUpperCase(), clientSecret}), true);
  for (const change of [{rawBody: Buffer.from(JSON.stringify(JSON.parse(rawBody)))}, {signature: '00'.repeat(32)},
    {signature: 'not-hex'}, {signature: ''}, {rawBody: rawBody.toString()}, {clientSecret: ''}]) {
    assert.equal(verifySupplierWebhookSignature({rawBody, signature, clientSecret, ...change}), false);
  }
});
