from pathlib import Path
import re,json
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'.deploy/visual-colors';OUT.mkdir(parents=True,exist_ok=True)
source=(ROOT/'app.js').read_text()
def declaration(name):
    m=re.search(r'^(?:async )?function '+name+r'\(',source,re.M)
    assert m,name
    return source[m.start():source.index('\n}',m.start())+2]
html=(ROOT/'index.html').read_text()
html=re.sub(r'<script\b[^>]*>[\s\S]*?</script>','',html)
html=re.sub(r'<link\b[^>]*>','',html)
html=html.replace('</head>', '<style>'+(ROOT/'styles.css').read_text()+'</style><style>'+(ROOT/'movement-colors.css').read_text()+'</style></head>')
setup='''
window.$=id=>document.getElementById(id);
window.escapeHtml=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;');
window.money=n=>'$ '+Number(n).toLocaleString('es-AR');
window.signedMoney=n=>(n>0?'+':n<0?'−':'')+money(Math.abs(n));
window.parseMoneyInput=Number;
window.previewSettlementBalance=()=>1406876;
window.normalizedSettlementBalance=Number;
window.settlementPreviewCopy=n=>({label:n>0?'Chofer debe':'Explora debe',amount:Math.abs(n)});
window.receiptBalanceLabel=n=>settlementPreviewCopy(n).label+' '+money(Math.abs(n));
window.isUberReceipt=r=>r.type==='uber_receipt';
window.isReimbursementCompensation=r=>['debt_compensation','reimbursement_compensation'].includes(r.type);
window.isCashAdvance=r=>r.type==='cash_advance';
window.isExpenseReceipt=r=>r.type==='expense_receipt';
window.isCashboxReceipt=r=>r.type==='cashbox_receipt';
window.isAdminDebt=r=>r.type==='admin_debt';
window.isSettlementAdjustment=r=>r.type==='settlement_adjustment';
window.cashboxIsExcluded=()=>false;
window.uberUsesGrossCashRule=()=>false;
window.receiptFooterLabel=()=> '14/09/26 · prueba local';
window.debtProofIsImage=()=>false;
window.managementDirection='';
'''
functions='\n'.join(declaration(n) for n in ['receiptBalanceSnapshot','renderList','renderChargePreview','renderExpenseTypes','renderExpensePreview','selectManagement','renderManagementPreview'])
cases=[('Cobro digital',{'method':'digital'},'green',-85000),('Caja digital · 5%',{'type':'cashbox_receipt','method':'digital'},'red',4250),('Cobro efectivo',{'method':'cash'},'red',32500),('Caja efectivo · 5%',{'type':'cashbox_receipt','method':'cash'},'red',1625),('Gasto 50% a 50%',{'type':'expense_receipt','expenseType':'combustible','receiptFlowVersion':'gross_expense_policy_v3'},'red',35000),('Reintegro de gasto',{'type':'expense_reimbursement_receipt'},'green',-17500),('Gasto 100% Explora',{'type':'expense_receipt','expenseType':'cubiertas','receiptFlowVersion':'gross_expense_policy_v3'},'green',10000),('Gasto 100% chofer',{'type':'expense_receipt','expenseType':'multa','receiptFlowVersion':'gross_expense_policy_v3'},'red',10000),('Pagar a Explora',{'type':'settlement_adjustment','direction':'driver_to_explora'},'green',-10000),('Cobrar a Explora',{'type':'settlement_adjustment','direction':'explora_to_driver'},'red',10000)]
rows=[]
for i,(title,row,col,impact) in enumerate(cases):
 rows.append(dict(row,service=title,amount=abs(impact),financialConfirmedReceipt=True,confirmedBefore=1406876,confirmedAfter=1406876+impact,financialSequence=i+1))
expected={'green':'rgb(0, 153, 61)','red':'rgb(230, 38, 50)'}
results=[]
try:
 with sync_playwright() as p:
  browser=p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  for width in [390,412,1280]:
   context=browser.new_context(viewport={'width':width,'height':844},device_scale_factor=1)
   context.route('**/*',lambda route:route.abort())
   page=context.new_page()
   page.set_content(html,wait_until='load')
   page.add_script_tag(content=(ROOT/'functions/expense-policy.js').read_text())
   page.add_script_tag(content=(ROOT/'movement-colors.js').read_text().replace('export function','function'))
   page.add_script_tag(content=setup+'\n'+functions)
   page.evaluate("rows=>{document.querySelectorAll('.modal').forEach(n=>n.classList.add('hidden'));$('loginScreen').classList.add('hidden');$('splashScreen').classList.add('hidden');$('app').classList.remove('hidden');$('app').classList.add('driver-view');$('driverDashboard').classList.remove('hidden');renderList('receiptList',rows)}",rows)
   history=page.locator('#receiptList .movement-card').evaluate_all("nodes=>nodes.map(n=>({type:n.dataset.movementColor,icon:getComputedStyle(n.querySelector('.movement-icon')).color,impact:getComputedStyle(n.querySelector('.movement-balances strong')).color}))")
   for record,case in zip(history,cases):
    assert record['impact']==expected[case[2]],(width,case[0],record)
    assert record['icon']==expected[case[2]],(width,case[0],record)
   if width==390:page.locator('#receiptList').screenshot(path=str(OUT/'historial_390.png'))
   # Current actual modal markup + original preview rendering, no Firebase involved.
   previews=[]
   for method,col in [('cash','red'),('digital','green')]:
    page.evaluate("method=>{$('chargeMode').value=method;$('chargeAmount').value='85000';renderChargePreview();}",method)
    principal=page.locator('#chargeAccountPreview > div:nth-child(2) strong').evaluate('(e)=>getComputedStyle(e).color')
    fee=page.locator('#chargeCashboxPreview > div:nth-child(2) strong').evaluate('(e)=>getComputedStyle(e).color')
    assert principal==expected[col],(method,principal);assert fee==expected['red'],(method,fee)
    previews.append({'method':method,'principal':principal,'fee':fee})
   for et,col in [('combustible','red'),('multa','red'),('cubiertas','green')]:
    page.evaluate("et=>{$('expenseType').value=et;$('expenseAmount').value='35000';renderExpensePreview();}",et)
    actual=page.locator('#expenseGrossPreview > div:nth-child(2) strong').evaluate('(e)=>getComputedStyle(e).color')
    assert actual==expected[col],(et,actual)
    if et!='multa':
     refund=page.locator('#expenseRefundPreview > div:nth-child(2) strong').evaluate('(e)=>getComputedStyle(e).color')
     assert refund==expected['green'],refund
   for direction,col in [('driver_to_explora','green'),('explora_to_driver','red')]:
    page.evaluate("direction=>{selectManagement(direction);$('managementAmount').value='10000';renderManagementPreview();}",direction)
    actual=page.locator('#managementPreview > div:nth-child(2) strong').evaluate('(e)=>getComputedStyle(e).color')
    assert actual==expected[col],(direction,actual)
   # Group option icons and quick actions also must respect the same map.
   page.evaluate('renderExpenseTypes()')
   for group,col in [('shared','red'),('driver','red'),('explora','green')]:
    icon=page.locator(f'.expense-type-group[data-responsibility="{group}"] svg').first.evaluate('(e)=>getComputedStyle(e).stroke')
    assert icon==expected[col],(group,icon)
   for method,col in [('cash','red'),('digital','green')]:
    actual=page.locator(f'#driverDashboard [data-mode="{method}"] svg').evaluate('(e)=>getComputedStyle(e).color')
    assert actual==expected[col],(method,actual)
   # Sidebar/admin card colors are checked using the current generated templates' CSS classes.
   for cls in ['admin-movement-item','admin-history-item']:
    for col in ['green','red']:
     val=page.evaluate("([cls,col])=>{const n=document.createElement('article');n.className=cls;n.dataset.movementColor=col;n.innerHTML='<div class=admin-history-top><span>Prueba</span><b>$ 100</b></div>';document.body.append(n);const color=getComputedStyle(n.querySelector('b')).color;n.remove();return color}",[cls,col])
     assert val==expected[col],(cls,col,val)
   results.append({'viewport':width,'history_cases':len(history),'modal_and_action_checks':'passed','cash_digital':previews})
   context.close()
  browser.close()
finally:pass
(OUT/'resultado.json').write_text(json.dumps({'engine':'Chromium desktop with 390/412/1280 CSS viewport; not physical Safari or Android','external_network':'blocked','tests':results},indent=2))
print(json.dumps(results,indent=2))
