import fs from 'node:fs/promises';
import path from 'node:path';
import { Workbook } from '@oai/artifact-tool';

const directory=path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/,''));
const root=process.cwd();
const inventory=JSON.parse(await fs.readFile(path.join(directory,'inventory.json'),'utf8'));
const batches=JSON.parse(await fs.readFile(path.join(directory,'coverage-batches.json'),'utf8'));
const findings=JSON.parse(await fs.readFile(path.join(directory,'findings.json'),'utf8'));
const reviewed={};
for(const batch of batches) for(const id of batch.tasks) {
  if(!inventory.some(t=>t.id===id)) throw new Error(`Unknown task ${id}`);
  reviewed[id]={status:batch.status,notes:batch.notes,sources:batch.sources};
}
for(const task of inventory) {
  if(!reviewed[task.id] && ['P10','P11'].includes(task.phase) && task.existingOwned.length===0) {
    reviewed[task.id]={status:'no_implementation',sources:task.card+';'+task.owned.map(p=>p+' (absent)').join(';'),notes:'Reviewed task ownership and current source inventory. The listed implementation/evidence paths are absent. Later planned work has no implementation here to review; this is not a completed-feature defect or a runtime pass.'};
  }
}
const needles={R003:'await this.db.withTransactionAsync',R004:'async resetPersona'};
for(const f of findings) {
  const source=await fs.readFile(path.join(root,f.file),'utf8');
  const lines=source.split(/\r?\n/);
  if(f.id==='R003') f.line=lines.findIndex(l=>l.includes('await db.withTransactionAsync(work)'))+1;
  if(f.id==='R004') f.line=lines.findIndex(l=>l.includes('await this.db.withTransactionAsync'))+1;
  if(f.line<1 || f.line>lines.length) throw new Error(`Invalid source location ${f.id}`);
  for(const id of f.tasks.split(';')) if(!inventory.some(t=>t.id===id)) throw new Error(`Unknown finding task ${id}`);
}
const columns=['Finding ID','Severity','Tasks','Title','File','Line','Trigger / reproduction scenario','Impact','Source evidence','Suggested fix','Verification','Remediation owner'];
const rows=findings.map(f=>[f.id,f.severity,f.tasks,f.title,f.file,f.line,f.trigger,f.impact,f.evidence,f.fix,f.verification,f.owner]);
const coverageColumns=['Task','Title','Phase','Task card','Implementation paths present','Review status','Findings','Inspected sources','Notes'];
const coverageRows=inventory.map(t=>[t.id,t.title,t.phase,t.card,t.existingOwned.join(';'),reviewed[t.id]?.status??'pending_review',findings.filter(f=>f.tasks.split(';').includes(t.id)).map(f=>f.id).join(';'),reviewed[t.id]?.sources??'',reviewed[t.id]?.notes??'Task not yet reviewed. No clean bill of health implied.']);
const workbook=Workbook.create();
const a=workbook.worksheets.add('Findings');
const b=workbook.worksheets.add('Task coverage');
a.getRange(`A1:L${rows.length+1}`).values=[columns,...rows];
b.getRange(`A1:I${coverageRows.length+1}`).values=[coverageColumns,...coverageRows];
workbook.recalculate();
const quote=v=>'"'+String(v??'').replaceAll('"','""')+'"';
const emit=matrix=>'\uFEFF'+matrix.map(row=>row.map(quote).join(',')).join('\r\n')+'\r\n';
await fs.writeFile(path.join(directory,'code-review-findings.csv'),emit(a.getRange(`A1:L${rows.length+1}`).values),'utf8');
await fs.writeFile(path.join(directory,'task-review-coverage.csv'),emit(b.getRange(`A1:I${coverageRows.length+1}`).values),'utf8');
const sourceAudit=JSON.parse(await fs.readFile(path.join(directory,'source-audit.json'),'utf8'));
const state={asOf:new Date().toISOString(),head:sourceAudit.commit,sourceAudit:'source-audit.json',scope:'All original and continuation task cards. Source review only for blockers, crashes, severe data loss, security release blockers, and core feature disabling defects. No implementation edits or product tests. Unimplemented and held tasks are recorded separately; runtime milestone completion is not asserted.',reviewed,findings};
await fs.writeFile(path.join(directory,'review-state.json'),JSON.stringify(state,null,2)+'\n');
const reimport=await Workbook.fromCSV((await fs.readFile(path.join(directory,'code-review-findings.csv'),'utf8')).replace(/^\uFEFF/,''),{sheetName:'Findings'});
const values=reimport.worksheets.getItem('Findings').getRange(`A1:L${rows.length+1}`).values;
if(values.length!==rows.length+1 || values.some((row,i)=>row.some((value,j)=>String(value??'')!==String([columns,...rows][i][j]??'')))) throw new Error('CSV round trip failed');
const summary={tasks:inventory.length,reviewed:Object.values(reviewed).filter(v=>!v.status.startsWith('partial')).length,partial:Object.values(reviewed).filter(v=>v.status.startsWith('partial')).length,pending:inventory.filter(t=>!reviewed[t.id]).length,findings:findings.length,csvRoundTrip:'checked'};
console.log(JSON.stringify(summary));
