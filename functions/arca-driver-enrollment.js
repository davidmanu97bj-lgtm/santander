'use strict';

// Read during the transaction's read phase. The caller applies this plan with
// the real driver's profile, so failed/retried registrations cannot enroll alone.
async function prepareArcaDriverEnrollment({db,tx,uid,arrayUnion}) {
  const ref=db.collection('arca_settings').doc('current');
  const snapshot=await tx.get(ref);
  if(!snapshot.exists)return {status:'settings_missing'};
  const approved=snapshot.data()?.approvedDriverUids;
  if(approved===undefined)return {status:'allowlist_missing'};
  if(!Array.isArray(approved)||approved.some(value=>typeof value!=='string'||!value.trim())) {
    return {status:'allowlist_invalid'};
  }
  if(approved.includes(uid))return {status:'already_approved'};
  return {status:'enrolled',ref,update:{approvedDriverUids:arrayUnion(uid)}};
}

module.exports={prepareArcaDriverEnrollment};
