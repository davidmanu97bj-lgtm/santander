// Only new, manually reconciled Fleet weeks use this rule. Historical weeks keep theirs.
(function(root,factory){const policy=factory();if(typeof module==='object'&&module.exports)module.exports=policy;else root.ExploraUberWeeklyPolicy=policy;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const VERSION='uber_admin_fleet_split_10_v1';
  const WORKFLOW='v86_admin_fleet_weekly';
  const roundMoney=value=>Math.round((Number(value)||0)*100)/100;
  const isNew=item=>item?.settlementRuleVersion===VERSION;
  function calculate({cashAmount=0,transferAmount=0}={}) {
    const cashCents=Math.round(Number(cashAmount)*100),digitalCents=Math.round(Number(transferAmount)*100);
    const boxCents=Math.round((cashCents+digitalCents)/10);
    const balanceCents=Math.round((cashCents-digitalCents)/2+boxCents);
    return {cash:cashCents/100,digital:digitalCents/100,total:(cashCents+digitalCents)/100,cashbox:boxCents/100,balance:balanceCents/100};
  }
  // The existing ledger already includes 5% of Uber cash.
  const supplementalCashbox=item=>isNew(item)?calculate(item).cashbox-Number(item.cashAmount||0)*.05:0;
  // Reconcile each new week's half-cent split to its settled integer-cent amount.
  // Keeping this separate from cashbox preserves the actual cashbox shown in UI.
  const roundingAdjustment=item=>{if(!isNew(item))return 0;const a=calculate(item);return a.balance-((a.cash-a.digital)*.5+a.cashbox);};
  const confirmed=item=>isNew(item)&&item.settlementWorkflowVersion===WORKFLOW&&item.adminConfirmed===true&&String(item.reviewStatus||item.status||'').toLowerCase()==='completed';
  return Object.freeze({VERSION,WORKFLOW,isNew,calculate,supplementalCashbox,roundingAdjustment,roundMoney,confirmed});
});
