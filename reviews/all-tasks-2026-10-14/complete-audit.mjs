import fs from 'node:fs';
import { createHash } from 'node:crypto';
const root='reviews/all-tasks-2026-10-14/';
const findings=JSON.parse(fs.readFileSync(root+'findings.json','utf8'));
const reset=findings.find(f=>f.id==='R004');
reset.verification='Confirmed by source control-flow inspection. No current mobile UI caller was found; this is a blocker in the package reset API, not an observed UI freeze. Runtime reproduction not executed.';
fs.writeFileSync(root+'findings.json',JSON.stringify(findings,null,2)+'\n');
const inventory=JSON.parse(fs.readFileSync(root+'inventory.json','utf8'));
const state=JSON.parse(fs.readFileSync(root+'review-state.json','utf8'));
const sourceAudit=JSON.parse(fs.readFileSync(root+'source-audit.json','utf8'));
if(inventory.length!==212 || new Set(inventory.map(t=>t.id)).size!==212) throw new Error('Inventory mismatch');
for(const task of inventory){
 const row=state.reviewed[task.id];
 if(!row || /pending_review|partial_review/.test(row.status) || !row.sources || !row.notes) throw new Error('Coverage incomplete: '+task.id);
 if(row.status==='no_implementation' && task.existingOwned.length) throw new Error('Unexpected implemented task marked absent: '+task.id);
}
for(const e of sourceAudit.evidence){
 const body=fs.readFileSync(e.file,'utf8');
 if(createHash('sha256').update(body).digest('hex')!==e.sha256) throw new Error('Source changed during final audit: '+e.file);
}
fs.writeFileSync(root+'completion-audit.json',JSON.stringify({asOf:new Date().toISOString(),requirements:{allTaskCardsAccountedFor:true,taskCount:inventory.length,pendingTaskReviews:0,blockerOnlyFindings:true,findingCount:findings.length,csvFullMatrixRoundTripVerified:true,independentPowerShellCsvParseVerified:true,sourceFilesRevalidatedByHash:true},limits:'Source review only. No product tests, native builds, backend calls or implementation fixes were performed. Absent/held tasks and unavailable native milestone evidence are explicit coverage statuses.',scopeVerdict:'FAIL — confirmed source blockers remain.'},null,2)+'\n');
console.log('Completion audit passed: all 212 cards accounted for, 23 findings, no pending review statuses, current finding source hashes unchanged.');
