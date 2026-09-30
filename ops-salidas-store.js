import { OPS_EXITS_COLLECTION, REMIS_NUMBERS, opsDayKey, paymentFitsExit, paymentTime } from './ops-salidas.js';

export const OPS_LINKS_COLLECTION = 'ops_exit_payment_links';

// This adapter writes operational documents only. It never updates a billing record,
// wallet or closure; the payment is read again inside the atomic link transaction.
export function createOpsExitStore({ db, doc, runTransaction, serverTimestamp, getActor, now = Date.now }) {
  const actor = () => {
    const user = getActor();
    if (!user?.uid) throw new Error('Solo administración puede actualizar salidas.');
    return user;
  };
  const reference = (collection, id) => {
    if (typeof id !== 'string' || !id || id.includes('/')) throw new Error('Identificador inválido.');
    return doc(db, collection, id);
  };
  return {
    async markExit(draft) {
      const user = actor();
      if (!REMIS_NUMBERS.includes(draft.remisNumber) || !(draft.markedAtMs > 0) || draft.markedAtMs > now()
        || draft.dayKey !== opsDayKey(draft.markedAtMs)) throw new Error('Salida inválida.');
      const ref = reference(OPS_EXITS_COLLECTION, draft.id);
      await runTransaction(db, async tx => {
        const old = await tx.get(ref);
        if (actor().uid !== user.uid) throw new Error('La sesión cambió.');
        if (old.exists()) {
          const value = old.data();
          if (value.remisNumber !== draft.remisNumber || value.markedAtMs !== draft.markedAtMs) throw new Error('La salida ya existe.');
          return; // Retry after a lost response retains the original departure time.
        }
        tx.set(ref, { version:2, dayKey:draft.dayKey, remisNumber:draft.remisNumber,
          markedAtMs:draft.markedAtMs, active:true, markedByUid:user.uid, markedByName:user.name || '',
          createdAt:serverTimestamp() });
      });
    },
    async linkPayment({exitId, paymentId}) {
      const user = actor();
      const exitRef = reference(OPS_EXITS_COLLECTION, exitId);
      const paymentRef = reference('billing_records', paymentId);
      const linkRef = reference(OPS_LINKS_COLLECTION, paymentId);
      return runTransaction(db, async tx => {
        const [exitSnap, paymentSnap, claimSnap] = await Promise.all([tx.get(exitRef), tx.get(paymentRef), tx.get(linkRef)]);
        if (actor().uid !== user.uid) throw new Error('La sesión cambió.');
        if (!exitSnap.exists() || !paymentSnap.exists()) throw new Error('La salida o el cobro ya no existe.');
        const exit = exitSnap.data();
        const payment = {...paymentSnap.data(), id:paymentId};
        if (claimSnap.exists() && claimSnap.data().exitId !== exitId) throw new Error('Ese cobro ya está vinculado a otra salida.');
        if (exit.paymentId && exit.paymentId !== paymentId) throw new Error('Esta salida ya tiene un cobro vinculado.');
        if (!paymentFitsExit(payment, exit)) throw new Error('El cobro no corresponde al número o es anterior a la salida.');
        if (exit.paymentId === paymentId && claimSnap.exists()) return;
        const linkedAtMs = now();
        tx.set(linkRef, {exitId, paymentId, linkedByUid:user.uid, linkedAt:serverTimestamp()});
        tx.update(exitRef, {paymentId, paymentAtMs:paymentTime(payment), linkedAtMs,
          linkedByUid:user.uid, linkedAt:serverTimestamp()});
      });
    }
  };
}
