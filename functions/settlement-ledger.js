'use strict';

// Server-only accounting boundary. All financial writes are staged until the
// common account and the source documents have been read in the SAME transaction.
// The calculator retains the original per-record rules and migration anchors.
const crypto = require('node:crypto');
const { calculateTeamRealtimeSettlementBalance } = require('./telegram-billing-balance');
const expensePolicy = require('./expense-policy');

const VERSION = 'confirmed_account_v1';
const ACCOUNTS = 'driver_settlement_accounts';
const ENTRIES = 'driver_settlement_entries';
const REQUESTS = 'settlement_commit_requests';
const SOURCE_KEYS = Object.freeze({ billing_records:'records', gastos:'expenses', uber_weekly_closures:'uberWeeks',
  cierres_semanales:'closures', deudas_choferes:'debts' });
const FINANCIAL = new Set([...Object.keys(SOURCE_KEYS), 'deuda_pagos', 'prestamos_operativos', 'deuda_movimientos']);
const OWNER_FIELDS = ['driverUid','operatorUid','choferUid','uid','ownerUid','driverId','choferId','userUid','createdByUid'];
const QUERY_FIELDS = ['driverUid','choferUid','uid','ownerUid','driverId','choferId','userUid','operatorUid','createdByUid'];
const round = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const ownerOf = row => OWNER_FIELDS.map(key => String(row?.[key] || '').trim()).find(Boolean) || '';
const collectionOf = path => String(path).split('/')[0];
const canonical = value => {
  if (value === undefined) return null;
  if (value === null || typeof value !== 'object') return value;
  if (typeof value.toMillis === 'function') return {$timestamp:value.toMillis()};
  if (value instanceof Date) return {$timestamp:value.getTime()};
  if (Array.isArray(value)) return value.map(canonical);
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
};
const digest = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

function createSettlementLedger({ db, Timestamp, FieldValue, Filter, HttpsError, clock = Date.now, maxDocuments = 12000 }) {
  const fail = (code,message,details) => { throw new HttpsError(code,message,details); };
  const stamp = ms => Timestamp.fromMillis(ms);
  function transform(value, previous, now) {
    if (value === undefined) fail('invalid-argument','Un campo financiero no puede ser undefined.');
    if (value === null || typeof value !== 'object' || value instanceof Date || typeof value.toMillis === 'function') return value;
    if (typeof value.isEqual === 'function') {
      if (value.isEqual(FieldValue.serverTimestamp())) return stamp(now);
      if (value.isEqual(FieldValue.delete())) return DELETE;
      // Admin SDK transform; used by the existing daily debt-penalty job.
      if (value.constructor?.name === 'NumericIncrementTransform' && Number.isFinite(value.operand ?? value._operand)) {
        return Number(previous || 0) + Number(value.operand ?? value._operand);
      }
      fail('invalid-argument','Transformación financiera no admitida.');
    }
    if (Array.isArray(value)) return value.map((v,i) => transform(v, previous?.[i], now));
    const result = {};
    for (const [key,child] of Object.entries(value)) {
      if (['__proto__','prototype','constructor'].includes(key)) fail('invalid-argument','Nombre de campo inválido.');
      const converted = transform(child, previous?.[key], now);
      if (converted !== DELETE) result[key] = converted;
    }
    return result;
  }
  const DELETE = Symbol('delete');
  function applyWrite(old, write, now) {
    if (write.kind === 'delete') return null;
    if (write.kind === 'create' && old) fail('already-exists','El movimiento ya existe.');
    if (write.kind === 'update' && !old) fail('not-found','El movimiento ya no existe.');
    const merge = write.kind === 'update' || write.options?.merge === true;
    const result = merge ? {...old} : {};
    // Application financial payloads use top-level updates. Nested map values in
    // set(...,{merge:true}) are merged recursively, matching the Firestore SDK.
    const mergeMap = (target,input) => {
      for (const [key,value] of Object.entries(input)) {
        if (key.includes('.')) fail('invalid-argument','Usá mapas, no rutas de campo con puntos.');
        if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.toMillis !== 'function'
            && typeof value.isEqual !== 'function' && !(value instanceof Date) && write.kind !== 'update') {
          const base = target[key] && typeof target[key] === 'object' && !Array.isArray(target[key]) ? {...target[key]} : {};
          mergeMap(base,value); target[key] = base;
        } else {
          const next = transform(value,target[key],now);
          if (next === DELETE) delete target[key]; else target[key] = next;
        }
      }
    };
    mergeMap(result,write.data || {});
    return result;
  }

  async function identityInTransaction(tx, rawUid) {
    if (!rawUid || rawUid.includes('/')) fail('failed-precondition','No se pudo identificar al chofer.');
    let profile = await tx.get(db.collection('choferes').doc(rawUid));
    if (!profile.exists) {
      const found = await tx.get(db.collection('choferes').where(Filter.or(
        ...['authUid','uid','driverUid'].map(field => Filter.where(field,'==',rawUid)))));
      if (found.docs.length > 1) fail('failed-precondition','Hay perfiles duplicados para este chofer. Conciliá su identidad antes de operar.');
      profile = found.docs[0] || profile;
    }
    const data = profile.exists ? profile.data() : {};
    const uid = String(data.authUid || data.uid || data.driverUid || rawUid);
    const aliases = [...new Set([rawUid,uid,profile.exists ? profile.id : ''].filter(Boolean))];
    return {uid, aliases, profileId:profile.exists ? profile.id : uid,
      name:String(data.displayName || data.nombreCompleto || data.nombre || data.username || 'Chofer')};
  }

  async function readSources(tx, identity) {
    const rows = {};
    let count = 0;
    await Promise.all(Object.entries(SOURCE_KEYS).map(async ([collection,key]) => {
      const filters = QUERY_FIELDS.flatMap(field => identity.aliases.map(uid => Filter.where(field,'==',uid)));
      const snapshot = await tx.get(db.collection(collection).where(Filter.or(...filters)));
      const items = snapshot.docs.filter(doc => identity.aliases.includes(ownerOf(doc.data())));
      count += items.length;
      rows[key] = items.map(doc => ({...doc.data(),id:doc.id}));
    }));
    if (count > maxDocuments) fail('resource-exhausted','Esta cuenta necesita archivado contable antes de continuar. No se aplicó ningún movimiento.');
    return rows;
  }
  function summary(rows, account) {
    const result = calculateTeamRealtimeSettlementBalance(rows);
    const versions = {}, counts = {};
    for (const [key,items] of Object.entries(rows)) {
      counts[key] = items.length;
      for (const item of items) {
        const version = item.settlementRuleVersion || item.receiptFlowVersion || item.settlementWorkflowVersion || 'legacy';
        versions[version] = (versions[version] || 0) + 1;
      }
    }
    const sourceHash = digest(rows);
    return {balance:round(result.balance), sourceHash, counts, versions, baselineMs:result.baseline || 0,
      effectiveCutoffMs:result.effectiveCutoffMs || 0, active:account?.status === 'active',
      confirmedBalance:account?.status === 'active' ? Number(account.balance) : null,
      sequence:Number(account?.sequence || 0), legacySnapshotsNotRewritten:true};
  }
  function historicSnapshotWarnings(rows) {
    const snapshots = Object.entries(SOURCE_KEYS).flatMap(([collection,key]) => rows[key]
      .filter(row=>row.financialOriginVersion!==VERSION)
      .map(row=>({path:`${collection}/${row.id}`,
        ms:Number(row.createdAt?.toMillis?.() || row.createdAtMs || 0),
        before:row.financialOriginalSnapshot?.before ?? row.telegramSettlementBeforeBalance,
        after:row.financialOriginalSnapshot?.after ?? row.telegramSettlementAfterBalance}))
      .filter(row=>typeof row.before==='number' && typeof row.after==='number' && Number.isFinite(row.before) && Number.isFinite(row.after)))
      .sort((a,b)=>a.ms-b.ms || a.path.localeCompare(b.path));
    const warnings=[];
    for(let i=1;i<snapshots.length;i++) {
      const previous=snapshots[i-1],next=snapshots[i],difference=round(next.before-previous.after);
      if(Math.abs(difference)>.005) warnings.push({previousSource:previous.path,nextSource:next.path,
        previousAfter:previous.after,nextBefore:next.before,difference,ambiguousTime:!next.ms || previous.ms===next.ms});
    }
    return {historicSnapshotCount:snapshots.length,historicDiscontinuityCount:warnings.length,
      historicDiscontinuities:warnings.slice(0,20),
      historicWarningNotice:'Alertas orientativas: fechas simultáneas, fotos faltantes, bajas o cambios anteriores pueden explicar diferencias. No prueban un saldo real incorrecto ni justifican un ajuste.'};
  }
  async function review(rawUid) {
    return db.runTransaction(async tx => {
      const identity = await identityInTransaction(tx,rawUid);
      const accountSnap = await tx.get(db.collection(ACCOUNTS).doc(identity.uid));
      const rows = await readSources(tx,identity);
      return {...summary(rows, accountSnap.data()),...historicSnapshotWarnings(rows), driverUid:identity.uid, driverName:identity.name};
    });
  }
  async function activate(rawUid, sourceHash, adminUid) {
    if (!/^[a-f0-9]{64}$/.test(sourceHash || '')) fail('invalid-argument','Primero revisá la cuenta.');
    return db.runTransaction(async tx => {
      const identity = await identityInTransaction(tx,rawUid);
      const ref = db.collection(ACCOUNTS).doc(identity.uid), snap = await tx.get(ref);
      const rows = await readSources(tx,identity), checked = summary(rows,snap.data());
      if (checked.sourceHash !== sourceHash) fail('aborted','Los movimientos cambiaron desde la revisión. Volvé a revisar el saldo.');
      if (snap.exists && snap.data().status === 'active') {
        if (Math.abs(snap.data().balance - checked.balance) > .005) fail('failed-precondition','La cuenta activa no coincide con sus fuentes. Requiere una auditoría; no se realizó un ajuste.');
        return {ok:true, alreadyActive:true,...checked,driverUid:identity.uid};
      }
      if (snap.exists) fail('failed-precondition','Una cuenta ya inicializada no se reinicia. Necesita una conciliación auditada.');
      const now = clock();
      const account = {driverUid:identity.uid,profileDocumentId:identity.profileId,driverName:identity.name,
        balance:checked.balance,sequence:0,status:'active',version:VERSION,openingBalance:checked.balance,
        openingSourceHash:sourceHash,activatedByUid:adminUid,activatedAt:stamp(now),lastCommittedAtMs:now,
        lastEntryId:'',updatedAt:stamp(now)};
      tx.create(db.collection('settlement_account_reviews').doc(`${identity.uid}_${now}`), {
        ...checked,driverUid:identity.uid,adminUid,reviewedAt:stamp(now),version:VERSION,
        notice:'Base reconstruida con reglas originales. No corrige fotografías históricas ni agrega dinero.'});
      tx.set(ref,account);
      tx.set(db.collection('team_realtime_balances').doc(identity.profileId), publicSummary(account));
      return {ok:true,...checked,driverUid:identity.uid,account};
    });
  }
  function publicSummary(account) {
    return {driverUid:account.driverUid,driverId:account.profileDocumentId,profileDocumentId:account.profileDocumentId,
      driverName:account.driverName,active:true,settlementBalance:account.balance,amount:Math.abs(account.balance),
      amountFromDriver:Math.max(0,account.balance),amountToDriver:Math.max(0,-account.balance),
      direction:account.balance > .5 ? 'driver_to_explora' : account.balance < -.5 ? 'explora_to_driver' : 'balanced',
      sequence:account.sequence,schemaVersion:2,calculationVersion:VERSION,
      updatedAtMs:account.lastCommittedAtMs,updatedAt:account.updatedAt};
  }

  function componentsFor(primary, old, next, before, after, context) {
    const collection = collectionOf(primary.ref.path), delta = round(after-before);
    const amount = Number(next?.amount || next?.grossAmount || 0);
    const pieces = [];
    const add = (title,impact,type='ledger_receipt',method='ledger') => pieces.push({title,impact:round(impact),type,method});
    if (!old && next && collection === 'billing_records' && !next.adjustmentDirection && next.settlementRuleVersion === 'gross_cash_digital_cashbox_5_v1') {
      const cash = next.method === 'cash';
      add(cash ? 'Cobro en efectivo' : 'Cobro digital', cash ? amount : -amount, 'ledger_receipt',cash ? 'cash' : 'digital');
      if (!next.excludeFromCashbox) add(`Caja ${cash ? 'efectivo' : 'digital'} · 5%`, amount*.05,'cashbox_receipt',cash ? 'cash' : 'digital');
    } else if (!old && next && collection === 'gastos' && next.receiptFlowVersion === expensePolicy.version) {
      add(`Gasto · ${next.expenseLabel || next.expenseType || 'Gasto'}`,amount,'expense_receipt','expense');
      const rate = expensePolicy.refundRate(next);
      if (rate) add(`Reintegro de gasto · ${rate*100}%`,-amount*rate,'expense_reimbursement_receipt','expense');
    } else if (!old && next && collection === 'uber_weekly_closures' && next.settlementRuleVersion === 'uber_gross_cash_cashbox_5_v1' && Math.abs(delta-amount*1.05)<.01) {
      add('Liquidación UBER',amount,'uber_receipt','uber'); add('Caja UBER · 5%',amount*.05,'cashbox_receipt','uber');
    }
    if (!pieces.length || Math.abs(round(pieces.reduce((n,x)=>n+x.impact,0))-delta)>.005) {
      pieces.length=0;
      const label = ({billing_records:'cobro',gastos:'gasto',deudas_choferes:'deuda',deuda_pagos:'pago de deuda',
        uber_weekly_closures:'Uber',cierres_semanales:'cierre',prestamos_operativos:'adelanto',deuda_movimientos:'deuda'})[collection] || 'movimiento';
      let title = primary.kind === 'delete' || next?.status === 'anulado' ? `Anulación de ${label}` : old ? `Actualización de ${label}` : `Registro de ${label}`;
      if (next?.internalManagement) title = next.adjustmentDirection === 'driver_to_explora' ? 'Pago a Explora' : 'Cobro a Explora';
      if (collection === 'deudas_choferes' && old && !old.acknowledgedByDriver && next?.acknowledgedByDriver) title = 'Deuda aceptada';
      if (context.reason) title = `Corrección de ${label}`;
      add(title,delta);
    }
    let cursor=before;
    return pieces.map((piece,index) => {
      const start=cursor; cursor=round(cursor+piece.impact);
      return {...piece,index,before:start,after:cursor,amount:Math.abs(piece.impact)};
    });
  }

  async function runTransaction(handler, context={}) {
    // Stable across Firestore retries. Cloud clients additionally supply a durable
    // request id. Entries use the account's sequence, not browser time or UUID sort.
    const requestId = context.requestId || crypto.randomUUID();
    const requestHash = context.requestHash || '';
    if (!/^[a-zA-Z0-9_-]{1,180}$/.test(requestId)) fail('invalid-argument','Identificador de operación inválido.');
    const requestRef = db.collection(REQUESTS).doc(requestId);
    return db.runTransaction(async native => {
      const requestSnap = await native.get(requestRef);
      if (requestSnap.exists) {
        const saved = requestSnap.data();
        if (saved.requestHash !== requestHash || saved.actorUid !== (context.actorUid || 'server')) fail('already-exists','Identificador reutilizado por otra operación.');
        return saved.response;
      }
      const writes = [], readCache=new Map();
      const get = async ref => {
        if (ref.path && readCache.has(ref.path)) return readCache.get(ref.path);
        const snap = await native.get(ref);
        if (ref.path && !snap.docs) readCache.set(ref.path,snap);
        return snap;
      };
      const stage = (kind,ref,data,options) => { writes.push({kind,ref,data,options}); return staged; };
      const staged = { get, getAll:async (...refs)=>Promise.all(refs.map(get)),
        set:(ref,data,options)=>stage('set',ref,data,options), update:(ref,data)=>stage('update',ref,data),
        create:(ref,data)=>stage('create',ref,data), delete:ref=>stage('delete',ref) };
      const result = await handler(staged);
      if (!writes.length) return {result,accounts:[],entries:[],noop:true};
      if (writes.length>120) fail('resource-exhausted','Dividí esta operación en lotes menores.');
      // One path per atomic operation makes change auditing unambiguous.
      if (new Set(writes.map(w=>w.ref.path)).size !== writes.length) fail('invalid-argument','Una operación no puede escribir dos veces el mismo documento.');
      const financial = writes.filter(w=>FINANCIAL.has(collectionOf(w.ref.path)));
      if (!financial.length) {
        for (const w of writes) flush(native,w);
        return {result,accounts:[],entries:[]};
      }
      const originals = new Map();
      for (const w of financial) { const snap=await get(w.ref); originals.set(w.ref.path,snap.exists?snap.data():null); }
      const identityMap = new Map(), writeOwner = new Map();
      for (const w of financial) {
        const old=originals.get(w.ref.path), raw=ownerOf(old || w.data);
        if (old && w.data && ownerOf(w.data) && ownerOf(w.data)!==raw) fail('failed-precondition','No se puede cambiar el chofer de un movimiento contable.');
        if (!identityMap.has(raw)) identityMap.set(raw,await identityInTransaction(native,raw));
        writeOwner.set(w.ref.path,identityMap.get(raw).uid);
      }
      const identities=[...new Map([...identityMap.values()].map(i=>[i.uid,i])).values()];
      if (identities.length>1 && !context.allowMultipleDrivers) fail('invalid-argument','Registrá cada chofer en su propia transacción.');
      const accountUpdates=[], entries=[], changes=[];
      for (const identity of identities) {
        const accountRef=db.collection(ACCOUNTS).doc(identity.uid), accountSnap=await native.get(accountRef);
        const current=accountSnap.exists?accountSnap.data():null;
        const rows=await readSources(native,identity), calculated=summary(rows,current);
        const total=Object.values(calculated.counts).reduce((a,b)=>a+b,0);
        if (current && current.status!=='active') fail('failed-precondition','Esta cuenta está suspendida y no admite movimientos.');
        if (!current || current.status!=='active') {
          if (total>0) fail('failed-precondition','La cuenta necesita activación de Admin en «Saldos seguros». No se guardó el movimiento.', {reason:'settlement-activation-required',driverUid:identity.uid});
        } else if (Math.abs(Number(current.balance)-calculated.balance)>.005) {
          fail('failed-precondition','El saldo confirmado no coincide con los movimientos. Se bloqueó la operación para no modificar dinero. Revisá «Saldos seguros».', {reason:'settlement-reconciliation-required',driverUid:identity.uid});
        }
        const before=current ? Number(current.balance) : calculated.balance;
        const now=Math.max(clock(),Number(current?.lastCommittedAtMs || 0)+1);
        const sequence=Number(current?.sequence || 0)+1;
        const owned=financial.filter(w=>writeOwner.get(w.ref.path)===identity.uid);
        const projected={...rows};
        const nextRows=new Map();
        for (const w of owned) {
          const old=originals.get(w.ref.path);
          let next=applyWrite(old,w,now);
          if (next) {
            // Financial timestamps are server-owned and stable on correction.
            if (!old) {
              if (next.createdAtMs) next.submittedAtMs=next.createdAtMs;
              next.createdAt=stamp(now); next.createdAtMs=now; next.financialOriginVersion=VERSION;
            } else {
              for (const key of ['createdAt','createdAtMs']) {
                if (Object.prototype.hasOwnProperty.call(old,key)) next[key]=old[key];
                else delete next[key];
              }
              next.updatedAt=stamp(now); next.updatedAtMs=now;
            }
            next.financialRevision=Number(old?.financialRevision || 0)+1;
          }
          nextRows.set(w.ref.path,next);
          const key=SOURCE_KEYS[collectionOf(w.ref.path)];
          if (key) projected[key]=[...projected[key].filter(r=>r.id!==w.ref.id),...(next?[{...next,id:w.ref.id}]:[])];
        }
        if (context.validateProjected) await context.validateProjected({identity,before,rows,projected,writes:owned,originals,nextRows});
        const after=round(calculateTeamRealtimeSettlementBalance(projected).balance);
        if (!Number.isFinite(before) || !Number.isFinite(after)) fail('failed-precondition','Saldo inválido. No se guardaron cambios.');
        // Prefer the receipt being CREATED, rather than its side effects (debt
        // allocations, closure status, consumed proof), for the transaction title.
        const primary=owned.find(w=>!originals.get(w.ref.path) && ['billing_records','gastos','uber_weekly_closures','deuda_pagos'].includes(collectionOf(w.ref.path))) || owned[0];
        const primaryOld=originals.get(primary.ref.path), primaryNext=nextRows.get(primary.ref.path);
        if (!primaryOld && primaryNext) {
          let expected = null;
          if (collectionOf(primary.ref.path)==='billing_records' && primaryNext.settlementRuleVersion==='gross_cash_digital_cashbox_5_v1' && !primaryNext.adjustmentDirection) {
            expected = Number(primaryNext.amount)*(primaryNext.method==='cash'?1:-1)
              + (primaryNext.excludeFromCashbox || primaryNext.cashboxExcluded ? 0 : Number(primaryNext.amount)*.05);
          } else if (collectionOf(primary.ref.path)==='billing_records' && primaryNext.internalManagement===true) {
            expected = Number(primaryNext.amount)*(primaryNext.adjustmentDirection==='driver_to_explora'?-1:1);
          } else if (collectionOf(primary.ref.path)==='cierres_semanales' && primaryNext.closureMode==='settlement_only'
            && primaryNext.reviewStatus==='pending') {
            expected = 0;
          } else if (collectionOf(primary.ref.path)==='gastos' && primaryNext.receiptFlowVersion===expensePolicy.version) {
            expected = Number(primaryNext.amount)*(1-expensePolicy.refundRate(primaryNext));
          } else if (collectionOf(primary.ref.path)==='uber_weekly_closures' && primaryNext.settlementWorkflowVersion==='v85_verified_direct') {
            expected = Number(primaryNext.amount)*1.05;
          }
          if (expected!==null && Math.abs(round(after-before)-round(expected))>.005) {
            fail('failed-precondition','La base o los cierres históricos impiden aplicar este movimiento con su regla. No se guardó: revisá la cuenta.');
          }
        }

        const entryId=`${identity.uid}_${String(sequence).padStart(12,'0')}`;
        const entry={driverUid:identity.uid,driverName:identity.name,sequence,version:VERSION,requestId,
          before,impact:round(after-before),after,createdAt:stamp(now),createdAtMs:now,
          sourceCollection:collectionOf(primary.ref.path),sourceId:primary.ref.id,
          sourcePaths:owned.map(w=>w.ref.path),actorUid:context.actorUid || 'server',reason:context.reason || '',
          detail:String(primaryNext?.detail || primaryNext?.notes || context.reason || primaryOld?.detail || ''),
          proofUrl:String(primaryNext?.proofUrl || primaryNext?.receiptUrl || primaryOld?.proofUrl || ''),
          proofPath:String(primaryNext?.proofPath || primaryNext?.receiptPath || primaryOld?.proofPath || ''),
          settlementRuleVersion:String(primaryNext?.settlementRuleVersion || primaryOld?.settlementRuleVersion || ''),
          components:componentsFor(primary,primaryOld,primaryNext,before,after,context)};
        entries.push({id:entryId,...entry});
        for (const w of owned) {
          const old=originals.get(w.ref.path), next=nextRows.get(w.ref.path);
          if (next) {
            if (old && !old.financialOriginalSnapshot && (old.telegramSettlementBeforeBalance!==undefined || old.telegramSettlementAfterBalance!==undefined)) {
              next.financialOriginalSnapshot={before:old.telegramSettlementBeforeBalance ?? null,after:old.telegramSettlementAfterBalance ?? null};
            }
            Object.assign(next,{financialLedgerVersion:VERSION,financialSequence:sequence,financialEntryId:entryId,
              telegramSettlementBeforeBalance:before,telegramSettlementAfterBalance:after,
              telegramSettlementPayer:after>.5?'driver':after<-.5?'explora':'balanced'});
            w.kind='set'; w.data=next; w.options=undefined;
          }
          changes.push({ref:db.collection('settlement_entry_changes').doc(`${entryId}_${changes.length}`),
            data:{driverUid:identity.uid,entryId,sourcePath:w.ref.path,before:old,after:next,createdAt:stamp(now),version:VERSION}});
        }
        const account={...(current || {}),driverUid:identity.uid,profileDocumentId:identity.profileId,driverName:identity.name,
          status:'active',version:VERSION,balance:after,sequence,lastEntryId:entryId,lastCommittedAtMs:now,updatedAt:stamp(now),
          ...(!current?{openingBalance:before,openingSourceHash:calculated.sourceHash,activatedAt:stamp(now),activatedByUid:'empty-account'}:{})};
        accountUpdates.push({ref:accountRef,data:account});
      }
      // All reads (including query reads) have finished. Nothing above writes to
      // Firestore, sends Telegram, uploads a file, or has an external side effect.
      for (const w of writes) {
        if (collectionOf(w.ref.path)==='admin_audit' && w.data && w.kind!=='delete') {
          const match = entries.find(e=>e.sourcePaths.some(path=>path.endsWith('/'+String(w.data.documentId || w.data.recordId || '')))) || (entries.length===1?entries[0]:null);
          if (match) w.data={...w.data,financialLedgerVersion:VERSION,financialEntryId:match.id,
            financialSequence:match.sequence,telegramSettlementBeforeBalance:match.before,telegramSettlementAfterBalance:match.after};
        }
        flush(native,w);
      }
      for (const {ref,data} of accountUpdates) {
        native.set(ref,data); native.set(db.collection('team_realtime_balances').doc(data.profileDocumentId),publicSummary(data));
      }
      for (const {id,...entry} of entries) native.create(db.collection(ENTRIES).doc(id),entry);
      for (const change of changes) native.create(change.ref,change.data);
      // Do not persist callback results: some old handlers return Timestamp or
      // SDK objects. API clients need the confirmed accounts and receipt ids.
      const response={accounts:accountUpdates.map(x=>x.data),entries:entries.map(({id,sequence,before,after})=>({id,sequence,before,after}))};
      native.create(requestRef,{actorUid:context.actorUid || 'server',requestHash,response,createdAt:stamp(clock()),version:VERSION});
      return {...response,result,confirmedSources:writes.filter(w=>FINANCIAL.has(collectionOf(w.ref.path)) && w.kind!=='delete').map(w=>({path:w.ref.path,data:w.data}))};
    });
  }
  function flush(tx,w) {
    if (w.kind==='delete') return tx.delete(w.ref);
    if (w.kind==='update') return tx.update(w.ref,w.data);
    if (w.kind==='create') return tx.create(w.ref,w.data);
    return w.options ? tx.set(w.ref,w.data,w.options) : tx.set(w.ref,w.data);
  }
  const set=(ref,data,options,context)=>runTransaction(tx=>tx.set(ref,data,options),context);
  const update=(ref,data,context)=>runTransaction(tx=>tx.update(ref,data),context);
  const remove=(ref,context)=>runTransaction(tx=>tx.delete(ref),context);
  return {runTransaction,set,update,remove,review,activate,publicSummary,readSources,identityInTransaction};
}

module.exports={createSettlementLedger,VERSION,ACCOUNTS,ENTRIES,REQUESTS,FINANCIAL,SOURCE_KEYS,OWNER_FIELDS,ownerOf,digest,canonical,round};
