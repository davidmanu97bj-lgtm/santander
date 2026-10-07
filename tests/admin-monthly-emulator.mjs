// Optional integration test against a Firestore emulator running firestore.rules.
// FIRESTORE_EMULATOR_HOST must be a local IPv4 endpoint; GCLOUD_PROJECT must be demo-*.
// EXPLORA_FIREBASE_CLIENT_ROOT points to an installed package with the Firebase SDK.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import path from 'node:path';
import {buildAdminDigitalExpense} from '../admin-digital-expense.js';
import {commitMonthlyExpense, monthlyChargeId, monthlyChargesForDriver} from '../admin-monthly-charges.js';

const endpoint = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:49199';
const projectId = process.env.GCLOUD_PROJECT || 'demo-explora-monthly';
assert.match(endpoint, /^127\.0\.0\.1:\d+$/);
assert.match(projectId, /^demo-/);
assert.ok(process.env.EXPLORA_FIREBASE_CLIENT_ROOT, 'Set EXPLORA_FIREBASE_CLIENT_ROOT to a folder containing package.json and firebase.');
const sdkRequire = createRequire(path.join(process.env.EXPLORA_FIREBASE_CLIENT_ROOT, 'package.json'));
const require = createRequire(import.meta.url);
const expensePolicy = require('../functions/expense-policy.js');
const periodPolicy = require('../functions/period-policy.js');
const {initializeApp, deleteApp} = sdkRequire('firebase/app');
const {getFirestore, connectFirestoreEmulator, doc, setDoc, updateDoc, getDoc, getDocs, collection,
  query, where, runTransaction, serverTimestamp} = sdkRequire('firebase/firestore');
const [host, port] = endpoint.split(':');
const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const driverUid = `monthly-driver-${suffix}`, month = '2026-10', passed = [];
function client(uid, admin = false) {
  const app = initializeApp({projectId, apiKey: 'local-only'}, uid);
  const db = getFirestore(app);
  connectFirestoreEmulator(db, host, Number(port), {mockUserToken: {sub: uid, user_id: uid, admin}});
  return {uid, app, db};
}
const adminA = client(`monthly-admin-a-${suffix}`, true);
const adminB = client(`monthly-admin-b-${suffix}`, true);
const driver = client(driverUid);
const denied = fn => assert.rejects(fn, error => error.code === 'permission-denied');
async function check(name, fn) { await fn(); passed.push(name); console.log('PASS ' + name); }

function request(actor, name, {concept = 'canon', typeId = concept, expenseMonth = month, uid = driverUid, withoutReceipt = true} = {}) {
  const operationId = `${name}-${suffix}`, fingerprint = `fingerprint-${operationId}`;
  const operation = {operationId, createdAtMs: Date.now()};
  const payload = buildAdminDigitalExpense({
    driver: {id: uid, name: 'Chofer mensual'}, actor: {uid: actor.uid, name: actor.uid, role: 'admin'},
    amount: 120000, detail: `Carga mensual ${concept}`, typeId, withoutReceipt, operation, fingerprint,
    businessId: 'explora', dayKey: '2026-10-07',
    ...(withoutReceipt ? {} : {proofUrl: 'https://example.test/monthly.pdf', proofPath: `gastos/${uid}/${operationId}/monthly.pdf`, file: {name: 'monthly.pdf', type: 'application/pdf'}})
  }, expensePolicy, periodPolicy);
  return {
    db: actor.db, expenseRef: doc(actor.db, 'gastos', operationId),
    guardRef: doc(actor.db, 'admin_audit', monthlyChargeId(uid, expenseMonth, concept)),
    payload: {...payload, expenseMonth, createdAt: serverTimestamp(), ...(withoutReceipt ? {receiptWaivedAt: serverTimestamp()} : {})},
    operationId, fingerprint, expenseRefById: id => doc(actor.db, 'gastos', id),
    guardData: {action: 'admin_monthly_expense', driverUid: uid, expenseMonth, concept, actorUid: actor.uid, createdAt: serverTimestamp()}
  };
}
const save = args => runTransaction(args.db, tx => commitMonthlyExpense({...args, tx}));
const read = async ref => (await getDoc(ref)).data();
async function driverExpenses() {
  return (await getDocs(query(collection(adminA.db, 'gastos'), where('driverUid', '==', driverUid))))
    .docs.map(snapshot => ({id: snapshot.id, ...snapshot.data()}));
}

// Both first attempts read the same empty guard before either is allowed to commit.
function concurrentSaves(requests) {
  let arrived = 0, release;
  const barrier = new Promise(resolve => { release = resolve; });
  const timeout = setTimeout(() => release(), 15000);
  return Promise.allSettled(requests.map(args => {
    let metBarrier = false;
    return runTransaction(args.db, tx => commitMonthlyExpense({...args, tx: {
      async get(ref) {
        const snapshot = await tx.get(ref);
        if (ref.path === args.guardRef.path && !metBarrier) {
          metBarrier = true;
          if (++arrived === requests.length) { clearTimeout(timeout); release(); }
          await barrier;
        }
        return snapshot;
      },
      set: (ref, data) => tx.set(ref, data)
    }}));
  })).then(results => { clearTimeout(timeout); assert.equal(arrived, requests.length, 'both transactions reached their guard read'); return results; });
}

try {
  await setDoc(doc(adminA.db, 'choferes', driverUid), {active: true});
  const first = request(adminA, 'concurrent-a', {typeId: 'canon_compartido'});
  const second = request(adminB, 'concurrent-b', {typeId: 'canon_compartido'});
  let winner;
  await check('two administrators racing for one driver/month/concept commit exactly one expense', async () => {
    assert.equal(first.guardRef.id, second.guardRef.id);
    const results = await concurrentSaves([first, second]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.find(result => result.status === 'rejected').reason.code, 'monthly-charge-exists');
    winner = results[0].status === 'fulfilled' ? first : second;
    const rows = await driverExpenses();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, winner.expenseRef.id);
    assert.equal((await read(first.guardRef)).expenseId, winner.expenseRef.id);
    assert.deepEqual(monthlyChargesForDriver(rows, driverUid, month).missing, ['patente']);
  });
  await check('same-operation retry preserves both expense and guard server timestamps', async () => {
    const beforeExpense = await read(winner.expenseRef), beforeGuard = await read(winner.guardRef);
    assert.deepEqual(await save(winner), {id: winner.expenseRef.id, duplicate: true});
    assert.deepEqual(await read(winner.expenseRef), beforeExpense);
    assert.deepEqual(await read(winner.guardRef), beforeGuard);
    const fingerprint = 'changed';
    await assert.rejects(save({...winner, fingerprint, payload: {...winner.payload, submissionFingerprint: fingerprint}}), {code: 'monthly-charge-conflict'});
    assert.equal((await driverExpenses()).length, 1);
  });
  await check('another concept and another month have independent guards and expenses', async () => {
    const patente = request(adminB, 'patente-driver', {concept: 'patente', typeId: 'patente_chofer'});
    const priorCanon = request(adminA, 'prior-canon', {expenseMonth: '2026-09'});
    await Promise.all([save(patente), save(priorCanon)]);
    assert.notEqual(patente.guardRef.id, winner.guardRef.id);
    assert.notEqual(priorCanon.guardRef.id, winner.guardRef.id);
    const rows = await driverExpenses();
    assert.equal(rows.length, 3);
    assert.deepEqual(monthlyChargesForDriver(rows, driverUid, month).missing, []);
    assert.deepEqual(monthlyChargesForDriver(rows, driverUid, '2026-09').missing, ['patente']);
    assert.deepEqual(monthlyChargesForDriver(rows, driverUid, '2026-11').missing, ['canon', 'patente']);
  });
  for (const typeId of ['canon_compartido', 'patente_chofer']) {
    await check(`driver cannot create administrative type ${typeId}, even with a receipt`, async () => {
      const attempted = request(driver, `driver-forbidden-${typeId}`, {concept: typeId === 'canon_compartido' ? 'canon' : 'patente', typeId, withoutReceipt: false});
      for (const expensePaymentMethod of ['digital', 'cash']) {
        await denied(() => setDoc(attempted.expenseRef, {...attempted.payload, expensePaymentMethod}));
        assert.equal((await getDoc(doc(adminA.db, 'gastos', attempted.expenseRef.id))).exists(), false);
      }
    });
  }
  await check('driver cannot create or overwrite the admin-only monthly guard', async () => {
    const id = monthlyChargeId(driverUid, '2026-08', 'canon');
    await denied(() => setDoc(doc(driver.db, 'admin_audit', id), {expenseId: 'forged'}));
    await denied(() => setDoc(doc(driver.db, 'admin_audit', winner.guardRef.id), {expenseId: 'forged'}));
    assert.equal((await getDoc(doc(adminA.db, 'admin_audit', id))).exists(), false);
    assert.equal((await read(winner.guardRef)).expenseId, winner.expenseRef.id);
  });
  await check('a forbidden guard write atomically rolls back the permitted expense write', async () => {
    const attempted = request(adminA, 'rollback', {expenseMonth: '2026-08'});
    // Administrators can read these fiscal drafts, but only server code may write them.
    attempted.guardRef = doc(adminA.db, 'arca_invoice_drafts', attempted.guardRef.id);
    await denied(() => save(attempted));
    assert.equal((await getDoc(attempted.expenseRef)).exists(), false);
    assert.equal((await getDoc(attempted.guardRef)).exists(), false);
    assert.deepEqual(monthlyChargesForDriver(await driverExpenses(), driverUid, '2026-08').missing, ['canon', 'patente']);
  });
  for (const status of ['cancelled', 'deleted']) {
    await check(`${status} expense can be replaced while its original history remains intact`, async () => {
      const expenseMonth = status === 'cancelled' ? '2026-07' : '2026-06';
      const original = request(adminA, `${status}-original`, {expenseMonth});
      await save(original);
      const before = await read(original.expenseRef);
      await updateDoc(original.expenseRef, {status, updatedAt: serverTimestamp()});
      assert.deepEqual(monthlyChargesForDriver(await driverExpenses(), driverUid, expenseMonth).missing, ['canon', 'patente']);
      const replacement = request(adminB, `${status}-replacement`, {expenseMonth, typeId: 'canon_compartido'});
      await save(replacement);
      const after = await read(original.expenseRef);
      assert.equal(after.status, status);
      assert.equal(after.amount, before.amount);
      assert.equal(after.createdAt.toMillis(), before.createdAt.toMillis());
      assert.equal(after.receiptWaivedAt.toMillis(), before.receiptWaivedAt.toMillis());
      assert.equal((await read(original.guardRef)).expenseId, replacement.expenseRef.id);
      assert.deepEqual(monthlyChargesForDriver(await driverExpenses(), driverUid, expenseMonth).missing, ['patente']);
    });
  }
  console.log(JSON.stringify({projectId, endpoint, passed: passed.length, tests: passed}, null, 2));
} finally {
  await Promise.all([deleteApp(adminA.app), deleteApp(adminB.app), deleteApp(driver.app)]);
}
