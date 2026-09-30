'use strict';

// Server-only, opt-in transport. Importing this module performs no I/O.
const {createHmac, timingSafeEqual, randomUUID} = require('node:crypto');

const AUTH_URL = 'https://auth.uber.com/oauth/v2/token';
const API_ORIGIN = 'https://api.uber.com';
const SUPPLIER_SCOPES = Object.freeze({
  organizations: 'vehicle_suppliers.organizations.read',
  transactions: 'supplier.partner.payments',
});
const LIMITS = Object.freeze({responseBytes: 2 * 1024 * 1024, pageSize: 500,
  pages: 20, cursorCount: 100, cursorTtlMs: 10 * 60 * 1000, timeoutMs: 10000});
const ISSUE = 'UBER_AMOUNTS_UNINTERPRETED';

class SupplierApiError extends Error {
  constructor(code, {status, retryAfterMs} = {}) {
    super(code);
    this.name = 'SupplierApiError';
    this.code = code;
    if (Number.isInteger(status)) this.status = status;
    if (Number.isFinite(retryAfterMs)) this.retryAfterMs = retryAfterMs;
  }
}
const fail = code => { throw new SupplierApiError(code); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9._~+/=-]{1,2048}$/.test(value);
const boundedText = (value, maximum = 2048) => typeof value === 'string' && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);

async function readJson(response, signal) {
  const declaredSize = response.headers?.get('content-length');
  if (declaredSize && (!/^\d+$/.test(declaredSize) || Number(declaredSize) > LIMITS.responseBytes)) {
    await response.body?.cancel().catch(() => {});
    fail('UBER_RESPONSE_TOO_LARGE');
  }
  if (!response.body || typeof response.body.getReader !== 'function') fail('UBER_INVALID_RESPONSE');
  const reader = response.body.getReader();
  const abort = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, {once: true});
  if (signal.aborted) abort();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > LIMITS.responseBytes) {
        await reader.cancel().catch(() => {});
        fail('UBER_RESPONSE_TOO_LARGE');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch (_) { fail('UBER_INVALID_RESPONSE'); }
}

function normalizeTransaction(row, organizationId) {
  if (!object(row) || !object(row.transactionInfo) || !object(row.driverInfo)) fail('UBER_INVALID_RESPONSE');
  const tx = row.transactionInfo;
  if (!identifier(tx.transactionUUID) || !identifier(row.driverInfo.driverUUID)) fail('UBER_INVALID_RESPONSE');
  if (tx.tripUUID != null && tx.tripUUID !== '' && !identifier(tx.tripUUID)) fail('UBER_INVALID_RESPONSE');
  if (tx.description != null && !boundedText(tx.description, 512)) fail('UBER_INVALID_RESPONSE');
  if (tx.processedAt != null && !boundedText(tx.processedAt, 64)) fail('UBER_INVALID_RESPONSE');
  // Money stays byte-for-byte equivalent JSON values in raw. Uber's published
  // amountE5/amountES and breakDown/breakDowns descriptions do not agree.
  return {
    kind: 'transaction_observation', source: 'uber_supplier_api', mode: 'shadow',
    organizationId, transactionId: tx.transactionUUID,
    tripId: tx.tripUUID || null, uberDriverId: row.driverInfo.driverUUID,
    processedAt: tx.processedAt || null, description: tx.description || null,
    raw: row,
  };
}

/**
 * All networking is explicitly injected. There is deliberately no global fetch
 * fallback, environment lookup, Firebase access, scheduler, or financial write.
 * now returns epoch milliseconds. timeoutMs is configurable only within 1..10000.
 */
function createSupplierClient({clientId, clientSecret, fetchImpl, now = Date.now, timeoutMs = LIMITS.timeoutMs} = {}) {
  if (!boundedText(clientId, 2048) || !clientId || !boundedText(clientSecret, 8192) || !clientSecret ||
      typeof fetchImpl !== 'function' || typeof now !== 'function' ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > LIMITS.timeoutMs) fail('UBER_CONFIG_INVALID');
  const tokens = new Map(), tokenRequests = new Map(), cursors = new Map();
  let authorizedOrganizations = null, organizationsAt = 0, transactionAllowedAt = 0;
  function clock() {
    const value = now();
    if (!Number.isSafeInteger(value) || value <= 0) fail('UBER_CLOCK_INVALID');
    return value;
  }
  async function request(url, options) {
    // This helper is private and additionally rejects unexpected routes. Redirects
    // are disabled so neither credentials nor bearer tokens can follow a URL.
    const target = new URL(url);
    if (!(url === AUTH_URL || (target.origin === API_ORIGIN &&
        ['/v1/vehicle-suppliers/orgs', '/v1/vehicle-suppliers/transactions'].includes(target.pathname)))) fail('UBER_ENDPOINT_INVALID');
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new SupplierApiError('UBER_TIMEOUT'));
      }, timeoutMs);
    });
    try {
      return await Promise.race([deadline, (async () => {
        const response = await fetchImpl(url, {...options, redirect: 'error', signal: controller.signal});
        if (!response || !Number.isInteger(response.status)) fail('UBER_INVALID_RESPONSE');
        if (response.status < 200 || response.status >= 300) {
          await response.body?.cancel().catch(() => {});
          const code = response.status === 401 ? 'UBER_UNAUTHORIZED' : response.status === 403 ? 'UBER_ACCESS_DENIED' :
            response.status === 429 ? 'UBER_RATE_LIMITED' : 'UBER_HTTP_ERROR';
          throw new SupplierApiError(code, {status: response.status});
        }
        return readJson(response, controller.signal);
      })()]);
    } catch (error) {
      if (error instanceof SupplierApiError) throw error;
      // Never attach upstream errors, URLs, headers, tokens or response bodies.
      throw new SupplierApiError('UBER_NETWORK_ERROR');
    } finally { clearTimeout(timer); }
  }
  async function accessToken(scope) {
    const cached = tokens.get(scope);
    if (cached && cached.expiresAt > clock() + 30000) return cached.value;
    if (tokenRequests.has(scope)) return tokenRequests.get(scope);
    const pending = (async () => {
      const body = new URLSearchParams({client_id: clientId, client_secret: clientSecret,
        grant_type: 'client_credentials', scope});
      const response = await request(AUTH_URL, {method: 'POST',
        headers: {'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json'}, body: body.toString()});
      if (!object(response) || !boundedText(response.access_token, 8192) || !response.access_token ||
          /\s/.test(response.access_token) || typeof response.token_type !== 'string' || response.token_type.toLowerCase() !== 'bearer' ||
          !Number.isSafeInteger(response.expires_in) || response.expires_in <= 30 || response.expires_in > 31536000 ||
          typeof response.scope !== 'string' || !response.scope.split(/\s+/).includes(scope)) fail('UBER_INVALID_TOKEN_RESPONSE');
      tokens.set(scope, {value: response.access_token, expiresAt: clock() + response.expires_in * 1000});
      return response.access_token;
    })();
    tokenRequests.set(scope, pending);
    try { return await pending; }
    finally { tokenRequests.delete(scope); }
  }
  async function call(path, scope, options = {}) {
    const token = await accessToken(scope);
    try {
      return await request(API_ORIGIN + path, {...options,
        headers: {Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${token}`}});
    } catch (error) {
      if (error.code === 'UBER_UNAUTHORIZED') tokens.delete(scope);
      if (['UBER_UNAUTHORIZED', 'UBER_ACCESS_DENIED'].includes(error.code)) {
        authorizedOrganizations = null;
        cursors.clear();
      }
      throw error;
    }
  }
  async function getOrganizations() {
    authorizedOrganizations = null;
    const response = await call('/v1/vehicle-suppliers/orgs', SUPPLIER_SCOPES.organizations, {method: 'GET'});
    if (!object(response) || !Array.isArray(response.organizations) || response.organizations.length > 2000) fail('UBER_INVALID_RESPONSE');
    const organizations = response.organizations.map(item => {
      if (!object(item) || !identifier(item.id) || (item.parent_org_id != null && !identifier(item.parent_org_id)) ||
          (item.name != null && !boundedText(item.name)) || !Array.isArray(item.types) || item.types.length > 20 ||
          item.types.some(type => !boundedText(type, 128))) fail('UBER_INVALID_RESPONSE');
      return {id: item.id, parentOrganizationId: item.parent_org_id || null, name: item.name || null, types: [...item.types]};
    });
    if (new Set(organizations.map(item => item.id)).size !== organizations.length) fail('UBER_INVALID_RESPONSE');
    authorizedOrganizations = new Set(organizations.map(item => item.id));
    organizationsAt = clock();
    return {organizations};
  }
  async function getRealtimeTransactions({organizationId, startTime, endTime, cursor} = {}) {
    const current = clock();
    if (!identifier(organizationId) || !Number.isSafeInteger(startTime) || !Number.isSafeInteger(endTime) ||
        startTime >= endTime || endTime - startTime > 15 * 60 * 1000 ||
        startTime < current - 24 * 60 * 60 * 1000 || endTime > current) fail('UBER_QUERY_INVALID');
    for (const [key, item] of cursors) if (item.expiresAt <= current) cursors.delete(key);
    const continuation = cursor === undefined ? null : cursors.get(cursor);
    if (cursor !== undefined && (!continuation || continuation.organizationId !== organizationId ||
        continuation.startTime !== startTime || continuation.endTime !== endTime || continuation.busy)) fail('UBER_CURSOR_INVALID');
    const page = continuation?.page || 1;
    if (continuation) continuation.busy = true;
    try {
      if (!authorizedOrganizations || current - organizationsAt >= 60000) await getOrganizations();
      if (!authorizedOrganizations?.has(organizationId)) fail('UBER_ORGANIZATION_NOT_AUTHORIZED');
      const readyAt = clock();
      if (readyAt < transactionAllowedAt) throw new SupplierApiError('UBER_RATE_LIMIT_LOCAL', {retryAfterMs: transactionAllowedAt - readyAt});
      transactionAllowedAt = readyAt + 1000;
      const response = await call('/v1/vehicle-suppliers/transactions?' + new URLSearchParams({org_id: organizationId}),
        SUPPLIER_SCOPES.transactions, {method: 'POST', body: JSON.stringify({
          filters: [{field: 'timeRange', operator: 'FILTER_OPERATOR_IN_RANGE', value: [String(startTime), String(endTime)]}],
          sort: [{field: 'processedAt', direction: 'DIRECTION_ASCENDING'}],
          // This spelling follows Uber's published request example. No automatic
          // variant/retry probes are sent when an account rejects that contract.
          pagination_options: {pageSize: LIMITS.pageSize, pageToken: continuation?.token || ''},
        })});
      const payload = object(response) && Object.hasOwn(response, 'body') ?
        (response.statusCode === 200 ? response.body : null) : response;
      if (!object(payload) || !Array.isArray(payload.transactions) || payload.transactions.length > LIMITS.pageSize ||
          !object(payload.paginationResult) || !boundedText(payload.paginationResult.nextPageToken)) fail('UBER_INVALID_RESPONSE');
      const observations = payload.transactions.map(row => normalizeTransaction(row, organizationId));
      const token = payload.paginationResult.nextPageToken;
      const seen = new Set(continuation?.seen || []);
      if (token && seen.has(token)) fail('UBER_PAGINATION_LOOP');
      if (token && page >= LIMITS.pages) fail('UBER_PAGE_LIMIT');
      let nextCursor = null;
      if (token) {
        if (cursors.size >= LIMITS.cursorCount) fail('UBER_CURSOR_LIMIT');
        seen.add(token);
        nextCursor = randomUUID();
        cursors.set(nextCursor, {organizationId, startTime, endTime, token, page: page + 1,
          seen: [...seen], expiresAt: current + LIMITS.cursorTtlMs, busy: false});
      }
      if (cursor !== undefined) cursors.delete(cursor);
      return {observations, nextCursor, issues: [ISSUE]};
    } finally { if (continuation) continuation.busy = false; }
  }
  return Object.freeze({getOrganizations, getRealtimeTransactions});
}

/** Verify the exact raw HTTP bytes, before parsing JSON. This does not authorize
 * an organization, establish freshness, or deduplicate delivery event IDs. */
function verifySupplierWebhookSignature({rawBody, signature, clientSecret} = {}) {
  if (!Buffer.isBuffer(rawBody) || rawBody.length > LIMITS.responseBytes ||
      typeof signature !== 'string' || !/^[a-fA-F0-9]{64}$/.test(signature) ||
      !boundedText(clientSecret, 8192) || !clientSecret) return false;
  const expected = createHmac('sha256', clientSecret).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}

module.exports = {createSupplierClient, verifySupplierWebhookSignature, SupplierApiError, SUPPLIER_SCOPES};
