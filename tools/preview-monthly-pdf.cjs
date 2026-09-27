const fs=require('node:fs');
const {buildMonthlyReport,monthlyPdf}=require('../functions/monthly-report');
const now=Date.parse('2026-10-02T12:00:00Z');
const report=buildMonthlyReport({uid:'demo',profile:{displayName:'CHOFER DE PRUEBA - EJEMPLO'},month:'2026-09',now,explora:{legalName:'GOMEZ DAVID EMANUEL'},input:{cobros:[{id:'demo-cash',type:'billing',method:'cash',amount:600000,status:'completed',createdAtMs:now,serviceDate:'2026-09-20'},{id:'demo-digital',type:'payment',method:'digital',amount:400000,status:'completed',createdAtMs:now,serviceDate:'2026-09-21'}]}});
(async()=>{const target=process.argv[2];fs.mkdirSync(require('node:path').dirname(target),{recursive:true});fs.writeFileSync(target,await monthlyPdf(report));console.log(target);})();
