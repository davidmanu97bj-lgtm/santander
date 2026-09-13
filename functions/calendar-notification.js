"use strict";

function precedes(candidate, current) {
  const a=candidate.createdAt, b=current.createdAt;
  if (!a || !b) return false;
  return a.seconds < b.seconds || (a.seconds === b.seconds && (
    a.nanoseconds < b.nanoseconds || (a.nanoseconds === b.nanoseconds && candidate.id < current.id)
  ));
}

// Save the notification decision once: retries must not count trips added later.
function createCalendarNotifier({db,notify,notificationKey,compact}) {
  return async event => {
    const data=event.data?.data(), id=event.params?.docId || event.data?.id;
    if (!data || !id || data.version !== 'trip_calendar_v1') return {skipped:true};
    const planRef=db.collection('calendar_notification_plans').doc(id);
    const plan=await db.runTransaction(async transaction => {
      const existing=await transaction.get(planRef);
      if(existing.exists) return existing.data();
      const sameDay=await transaction.get(db.collection('trip_calendar').where('serviceDate','==',data.serviceDate));
      const previous=sameDay.docs.map(item=>({...item.data(),id:item.id}))
        .filter(item=>item.id!==id && precedes(item,{...data,id}));
      const names=[...new Map(previous.map(item=>[item.driverUid,item.driverName])).values()];
      const result={driverName:data.driverName,serviceDate:data.serviceDate,coincidences:previous.length,otherDrivers:names};
      transaction.set(planRef,result);
      return result;
    });
    const common={docId:id,notificationKey:notificationKey(data,id),sourceCollection:'trip_calendar',
      sourceDocumentId:id,data,eventId:event.id,requirePhoto:false};
    await notify({...common,kind:'calendar_trip',caption:compact.calendarSummary(plan)});
    if(plan.coincidences) await notify({...common,kind:'calendar_coincidence',caption:compact.calendarCoincidenceSummary(plan)});
    return {notifications:plan.coincidences?2:1};
  };
}
module.exports={createCalendarNotifier,precedes};
