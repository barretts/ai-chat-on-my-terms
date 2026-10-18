import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Workbook } from '../all-tasks-2026-10-14/node_modules/@oai/artifact-tool/dist/artifact_tool.mjs';

const dir='reviews/all-tasks-2026-10-15';
const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const findings=await read(`${dir}/findings.json`);
const additions=[
 {id:'R025',tasks:'T110',title:'Backup restore inserts child tables before their parents',file:'apps/mobile/features/backup/db-snapshot.ts',needle:'for (const entry of staged)',trigger:'Back up a configured provider and its model, then restore into a clean initialized database with foreign keys enabled.',impact:'The models table sorts before providers, so inserting its provider reference fails before the parent is restored. Other child-first tables fail similarly. On an existing database, later parent deletes can also cascade away children already restored.',evidence:'snapshotDatabase orders sqlite_master by name; restoreTransaction deletes and inserts each table in archive order. models.provider_id references providers(id). No dependency ordering or deferred constraint handling is present.',fix:'Plan restore around foreign-key dependencies: clear safely, insert parents before children, and validate all references before commit. Account for cascading deletes and cyclic dependencies.',owner:'T110 database restore'},
 {id:'R026',tasks:'T110',title:'Backup object routes allow cross-user overwrite and deletion',file:'services/api/features/backup/index.ts',needle:'app.delete("/backup/objects/:id"',trigger:'Register these routes and upload a backup under a valid object ID. Another caller sends DELETE or PUT using that same ID.',impact:'The second caller can destroy or replace the backup without its passphrase or owner session. Encryption protects plaintext, not availability or ownership.',evidence:'GET, PUT and DELETE use the global object ID directly. There is no session resolution or owner check. The optional ProGate takes no request/user argument and defaults to allowed. The mobile object-store client sends no account credentials.',fix:'Require authenticated account ownership for every object operation, scope storage keys to the owner, and enforce entitlement per requesting account.',owner:'T110 backup storage authorization'},
 {id:'R027',tasks:'T106;T111;T112;T113',title:'Configured service providers create an endless refresh loop',file:'apps/mobile/features/account/provider.tsx',needle:'const client =',trigger:'Mount AccountProvider, BillingProvider, CommunityProvider or SupportProvider with baseUrl and without an injected stable client; return successful JSON responses.',impact:'Each state update creates a new client, changes refresh identity and reruns the refresh effect. Requests and renders continue indefinitely; account busy-state updates can overlap requests. Enabling these services makes the app continuously hit the API.',evidence:'All four providers construct create*Client in the render body, use client in refresh dependencies, and use refresh in an effect. Successful refresh stores fresh objects/arrays, causing the next render. The current root supplies no baseUrl, so this is conditional on configuring the supported service path.',fix:'Memoize each client and its token adapter by stable configuration, or construct it once outside render. Keep refresh effects stable across their own state updates.',owner:'Mobile account/billing/community/support providers'},
 {id:'R028',tasks:'T103',title:'Mobile and Rust companion cannot exchange remote chat messages',file:'apps/companion/composition/remote/mod.rs',needle:'if body["type"].as_str()',trigger:'Send createRemoteChatConnection.streamRun through attachRemoteSession to RemoteComposition.serve_chat.',impact:'The companion rejects the first legitimate mobile request as malformed; the phone never receives completion. Even after adapting the request, the response is raw backend bytes rather than the event/completion payloads the phone consumes.',evidence:'Mobile seals {tag:"request",body:{type:"chat-request",runId,routeId,messages,tools}}. Rust reads plaintext["type"] and requires top-level bodyBase64Url instead. Rust seals raw backend response bytes as one event frame; TS expects EncryptedPayload RunEvent objects plus chat-complete.',fix:'Use the same versioned payload and frame schema on both implementations, translate backend streaming events to RunEvents, and send terminal completion/failure. Review the real TS-to-Rust path rather than same-language fixtures.',owner:'T103 mobile/companion wire integration'}
];
for(const f of additions) if(!findings.some(x=>x.id===f.id)) findings.push({...f,severity:'P1',verification:'Confirmed by source-path and state/contract inspection; runtime reproduction not executed.',reviewStatus:'new'});
for(const f of findings) {
 const lines=(await fs.readFile(f.file,'utf8')).split(/\r?\n/);
 if(f.id==='R024') f.line=lines.findIndex(x=>x.includes('foregrounded(now)'))+1;
 if(f.needle) f.line=lines.findIndex(x=>x.includes(f.needle))+1;
 if(!(f.line>0&&f.line<=lines.length)) throw Error(`Invalid coordinate ${f.id}`);
}
findings.find(f=>f.id==='R008').evidence+=' Follow-up: T103 syncOneConversation pumps after acknowledgements in its separate integration helper; the core SyncEngine onFrame path identified here remains unchanged. This finding is scoped to that core composition path.';
findings.find(f=>f.id==='R002').verification='Confirmed by current path and manifest inspection; installer not executed. The earlier in-progress qualifier is superseded by this follow-up source review.';
const old=await read('reviews/all-tasks-2026-10-14/review-state.json');
const inventory=await read(`${dir}/inventory.json`);
const newer=await read(`${dir}/new-task-sources.json`);
const reviewed=structuredClone(old.reviewed);
for(const t of newer) reviewed[t.id]={status:'source_reviewed',sources:t.source.join(';'),notes:'Follow-up focused source review of implemented contracts, state transitions and integration paths for blockers and app-killing defects. No product tests, builds or device proofs executed.'};
for(const id of ['T114','T116','T117','T117D','T119']) reviewed[id].notes+=' Native bridge/device behavior and end-to-end workflow reachability are not established by these contract packages. T117 is a recipe ledger/registry; /workflows routes and live workflow invocation were not found in the mobile app. This is not end-to-end acceptance.';
reviewed.T001.notes+=' Follow-up root provider graph inspected; R024 added and R001 revalidated.';
const cols=['Finding ID','Severity','Tasks','Title','File','Line','Trigger / reproduction scenario','Impact','Source evidence','Suggested fix','Verification','Remediation owner','Review status'];
const rows=findings.map(f=>[f.id,f.severity,f.tasks,f.title,f.file,f.line,f.trigger,f.impact,f.evidence,f.fix,f.verification,f.owner,f.reviewStatus]);
const ccols=['Task','Title','Phase','Task card','Implementation paths present','Review status','Findings','Inspected sources','Notes'];
const crows=inventory.map(t=>[t.id,t.title,t.phase??oldTaskPhase(t.card),t.card,(t.existingOwned??t.source??[]).join(';'),reviewed[t.id]?.status??'no_implementation',findings.filter(f=>f.tasks.split(';').includes(t.id)).map(f=>f.id).join(';'),reviewed[t.id]?.sources??'',reviewed[t.id]?.notes??'No implementation present for focused review; no runtime pass asserted.']);
function oldTaskPhase(card){return /\/P\d+\//.exec(card)?.[0].replaceAll('/','')??'continuation';}
const wb=Workbook.create();
const sheets=[['Findings',cols,rows,'code-review-findings.csv','M'],['Task coverage',ccols,crows,'task-review-coverage.csv','I']];
const quote=v=>'"'+String(v??'').replaceAll('"','""')+'"';
for(const [name,header,data,file,end] of sheets){const s=wb.worksheets.add(name); s.getRange(`A1:${end}${data.length+1}`).values=[header,...data];}
wb.recalculate();
for(const [name,header,data,file,end] of sheets){
 const matrix=wb.worksheets.getItem(name).getRange(`A1:${end}${data.length+1}`).values;
 const csv='\uFEFF'+matrix.map(r=>r.map(quote).join(',')).join('\r\n')+'\r\n';
 await fs.writeFile(`${dir}/${file}`,csv);
 const back=await Workbook.fromCSV(csv.replace(/^\uFEFF/,''),{sheetName:name});
 const actual=back.worksheets.getItem(name).getRange(`A1:${end}${data.length+1}`).values;
 if(actual.some((r,i)=>r.some((v,j)=>String(v??'')!==String(matrix[i][j]??'')))) throw Error(`Round trip failed ${file}`);
}
const asOf=new Date().toISOString();
const files=[...new Set([...findings.map(f=>f.file),...newer.flatMap(t=>t.source),'apps/mobile/app/_layout.tsx'])];
const hashes=[];for(const file of files) hashes.push({file,sha256:crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex')});
await fs.writeFile(`${dir}/findings.json`,JSON.stringify(findings,null,2)+'\n');
await fs.writeFile(`${dir}/source-audit.json`,JSON.stringify({asOf,head:old.head,dirtyWorktree:true,files:hashes},null,2)+'\n');
await fs.writeFile(`${dir}/review-state.json`,JSON.stringify({asOf,head:old.head,scope:old.scope,baseline:'../all-tasks-2026-10-14',reviewed,findings,limitations:'Native bridges/device proofs, configured external services, and workflow reachability are not accepted by this static review. Later absent task implementations remain outside implemented-code coverage.'},null,2)+'\n');
await fs.writeFile(`${dir}/RESUME.md`, `# Completed follow-up review\n\nAs of ${asOf}, HEAD ${old.head}, dirty worktree source hashes in source-audit.json.\n\n212 task cards indexed. 28 open P1 findings: 23 earlier findings retained after source revalidation, 5 new (R024–R028). Only review artifacts changed by this review; no product tests or builds run. CSV exports round-tripped through artifact-tool.\n\nReview scope: blockers, app-killing defects, severe data loss and security release blockers. Coverage CSV distinguishes missing implementation from source review. Native/device end-to-end acceptance is still unverified. T117 currently supplies a ledger/registry, not reachable workflow routes.\n\nNext action: remediate findings, then verify their listed trigger scenarios. Preserve stable finding IDs; do not treat source review as product runtime acceptance.\n`);
console.log(JSON.stringify({tasks:inventory.length,followUpTasks:newer.length,open:findings.length,new:findings.filter(f=>f.reviewStatus==='new').length,csvRoundTrips:2,sourceFilesHashed:hashes.length}));
