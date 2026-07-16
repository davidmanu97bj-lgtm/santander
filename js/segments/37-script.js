
(()=>{
  "use strict";
  if(window.__exploraIdleDashboardRestartV2)return;
  window.__exploraIdleDashboardRestartV2=true;

  const IDLE_MS=120000;
  const CHECK_MS=5000;
  const STORAGE_KEY="explora:dashboard:last-valid:v1"; // sólo se elimina; ya no se restaura
  const RELOAD_GUARD_KEY="explora:dashboard:auto-reload-guard:v1";
  const MAX_SNAPSHOT_AGE_MS=6*60*60*1000;
  const TARGETS={
    performancePodium:"html",
    performanceDerivatorBody:"html",
    performanceGoalTrack:"html",
    dashboardWeeklyRevenue:"text",
    dashboardWeeklyRevenueMeta:"text",
    dashboardWeeklyExpenses:"text",
    dashboardWeeklyExpensesMeta:"text",
    dashboardReceiptsMeta:"text",
    dashboardExploreLoanMeta:"text",
    driverStatusCard:"html"
  };
  const TRANSIENT_RE=/calculando|cargando|sincronizando|actualizando|comprobando|espera un momento|todav[ií]a no hay choferes disponibles/i;
  const activityEvents=["pointerdown","touchstart","keydown","input","change","scroll","wheel"];
  let lastActivity=Date.now();
  let intervalId=0;
  let reloadScheduled=false;
  let observer=null;
  let saveTimer=0;
  let resumeRefreshInFlight=false;

  function node(id){return document.getElementById(id)}
  function isDashboardVisible(){
    const main=node("driverDashboardReal");
    if(main&&main.hidden)return false;
    if(document.body.classList.contains("explora-internal-screen-open"))return false;
    const blockers=[
      ".is-open:not(#dialogBackdrop)",
      "[aria-hidden='false'].vehicle-detail-screen",
      ".billing-form-backdrop.is-open",
      ".weekly-closure-overlay:not([hidden])",
      ".dialog-backdrop.open",
      ".admin-shared-screen[aria-hidden='false']"
    ];
    return !blockers.some(sel=>{try{return Boolean(document.querySelector(sel))}catch(_){return false}});
  }
  function hasUnsavedInteraction(){
    const active=document.activeElement;
    if(active&&/^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName))return true;
    return Boolean(document.querySelector("form input:not([type='hidden']):not(:disabled), form textarea:not(:disabled), .billing-form-backdrop.is-open, .expense-screen.is-open, .new-service-screen.is-open"));
  }
  function isValidValue(value){
    const clean=String(value||"").replace(/\s+/g," ").trim();
    return clean.length>0&&!TRANSIENT_RE.test(clean);
  }
  function collectSnapshot(){
    const data={savedAt:Date.now(),path:location.pathname,values:{}};
    let validPrimary=0;
    for(const [id,mode] of Object.entries(TARGETS)){
      const el=node(id);if(!el)continue;
      const value=mode==="text"?el.textContent:el.innerHTML;
      if(!isValidValue(value))continue;
      data.values[id]={mode,value};
      if(["performancePodium","performanceDerivatorBody","performanceGoalTrack"].includes(id))validPrimary++;
    }
    return validPrimary>=2?data:null;
  }
  function saveSnapshot(){
    clearTimeout(saveTimer);
    saveTimer=setTimeout(()=>{
      try{
        const data=collectSnapshot();
        if(data)sessionStorage.setItem(STORAGE_KEY,JSON.stringify(data));
      }catch(_){}
    },180);
  }
  function discardStoredSnapshot(){
    try{sessionStorage.removeItem(STORAGE_KEY)}catch(_){}
  }
  function restoreSnapshot(){
    // v4075: nunca se vuelven a pintar valores de una sesión visual anterior.
    discardStoredSnapshot();
    return false;
  }
  function noteActivity(){lastActivity=Date.now()}
  function canAutoReload(){
    if(reloadScheduled||!isDashboardVisible()||hasUnsavedInteraction())return false;
    if(document.body.classList.contains("is-scroll-locked"))return false;
    const session=window.ExploraSession||{};
    if(session.closing)return false;
    return true;
  }
  function autoReload(reason){
    if(!canAutoReload())return false;
    try{
      const last=Number(sessionStorage.getItem(RELOAD_GUARD_KEY)||0);
      if(Date.now()-last<45000)return false;
      saveSnapshot();
      const data=collectSnapshot();
      if(data)sessionStorage.setItem(STORAGE_KEY,JSON.stringify(data));
      sessionStorage.setItem(RELOAD_GUARD_KEY,String(Date.now()));
      sessionStorage.setItem("explora:dashboard:auto-reload-reason",String(reason||"idle"));
    }catch(_){}
    reloadScheduled=true;
    setTimeout(()=>location.reload(),120);
    return true;
  }
  async function refreshSessionWithoutReload(reason="resume"){
    if(resumeRefreshInFlight)return;
    const session=window.ExploraSession||{};
    if(!session.authUser?.uid&&!window.ExploraFirebase?.auth?.currentUser?.uid)return;
    resumeRefreshInFlight=true;
    const syncGate=window.ExploraDataSyncGate;
    const gateOpened=Boolean(syncGate?.begin?.("Actualizando saldos y actividades antes de continuar…"));
    try{
      syncGate?.update?.(18,"Verificando la sesión activa…");
      window.dispatchEvent(new CustomEvent("explora:app-resumed",{detail:{reason,reload:false,coveredUntilFresh:true}}));
      const tasks=[];
      const globalRefresh=window.ExploraFirestoreGlobalSync?.refresh?.({reason:`${reason}-no-reload`});
      if(globalRefresh&&typeof globalRefresh.then==="function")tasks.push(globalRefresh);
      const isAdmin=String(session.role||"").toLowerCase().includes("admin")||document.body.classList.contains("explora-shared-admin");
      if(isAdmin){
        const adminRefresh=window.ExploraAdminShared?.refresh?.();
        if(adminRefresh&&typeof adminRefresh.then==="function")tasks.push(adminRefresh);
      }else{
        const weeklyRefresh=window.ExploraWeeklyEngine?.loadOnce?.({force:true,reason:`${reason}-no-reload`});
        if(weeklyRefresh&&typeof weeklyRefresh.then==="function")tasks.push(weeklyRefresh);
        const sessionRefresh=window.ExploraLoadWeeklySession?.({force:true,reason:`${reason}-no-reload`});
        if(sessionRefresh&&typeof sessionRefresh.then==="function")tasks.push(sessionRefresh);
      }
      syncGate?.update?.(58,"Consultando la información actual…");
      if(tasks.length)await Promise.allSettled(tasks);
      syncGate?.update?.(94,"Información actual lista…");
    }catch(error){
      console.warn("[EXPLORA_RESUME_REFRESH_WARN]",error?.code||error?.message||error);
    }finally{
      if(gateOpened||syncGate?.isActive?.())await Promise.resolve(syncGate?.finish?.()).catch(()=>{});
      resumeRefreshInFlight=false;
    }
  }
  function checkIdle(){
    if(Date.now()-lastActivity<IDLE_MS)return;
    // La app ya no se recarga por inactividad. Sólo conserva una copia visual.
    saveSnapshot();
    lastActivity=Date.now();
  }
  function coverAuthenticatedDashboardForResume(){
    const session=window.ExploraSession||{};
    const authenticated=Boolean(session.authUser?.uid||window.ExploraFirebase?.auth?.currentUser?.uid);
    if(!authenticated||!document.body.classList.contains("explora-authenticated"))return false;
    return Boolean(window.ExploraDataSyncGate?.begin?.("Actualizando información antes de continuar…"));
  }
  function onVisibilityChange(){
    if(document.visibilityState==="hidden"){
      coverAuthenticatedDashboardForResume();
      saveSnapshot();
      return;
    }
    const hiddenAt=Number(sessionStorage.getItem("explora:dashboard:hidden-at")||0);
    const elapsed=hiddenAt?Date.now()-hiddenAt:0;
    if(hiddenAt&&elapsed>=15000)refreshSessionWithoutReload("resume-after-background");
    else if(window.ExploraDataSyncGate?.isActive?.())Promise.resolve(window.ExploraDataSyncGate.finish()).catch(()=>{});
    noteActivity();
  }
  function onPageHide(){
    coverAuthenticatedDashboardForResume();
    saveSnapshot();
    try{sessionStorage.setItem("explora:dashboard:hidden-at",String(Date.now()))}catch(_){}
  }
  function startObserver(){
    const roots=[node("weeklyRankingLive"),node("performanceGoalViewport"),node("driverStatusCard")].filter(Boolean);
    if(!roots.length)return;
    observer=new MutationObserver(()=>saveSnapshot());
    roots.forEach(root=>observer.observe(root,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:["hidden","class","data-status"]}));
  }
  function init(){
    discardStoredSnapshot();
    activityEvents.forEach(name=>window.addEventListener(name,noteActivity,{passive:true,capture:true}));
    document.addEventListener("visibilitychange",()=>{
      if(document.visibilityState==="hidden"){
        try{sessionStorage.setItem("explora:dashboard:hidden-at",String(Date.now()))}catch(_){}
      }
      onVisibilityChange();
    },true);
    window.addEventListener("pagehide",onPageHide,{capture:true});
    window.addEventListener("beforeunload",saveSnapshot,{capture:true});
    window.addEventListener("pageshow",event=>{
      if(event.persisted)refreshSessionWithoutReload("pageshow-bfcache");
    });
    startObserver();
    intervalId=window.setInterval(checkIdle,CHECK_MS);
    window.ExploraIdleDashboardRestart={
      version:"2.0.0",
      idleMs:IDLE_MS,
      save:saveSnapshot,
      restore:restoreSnapshot,
      restart:()=>autoReload("manual-api"),
      refresh:refreshSessionWithoutReload,
      resetActivity:noteActivity,
      stop:()=>{clearInterval(intervalId);observer?.disconnect?.();}
    };
    saveSnapshot();
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init,{once:true});
  else init();
})();
