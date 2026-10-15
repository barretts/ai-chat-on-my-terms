import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const root='reviews/all-tasks-2026-10-14/';
const f=JSON.parse(fs.readFileSync(root+'findings.json','utf8'));
const needles={R001:'"dependencies"',R002:'  - packages/*/*',R003:'await db.withTransactionAsync(work)',R004:'await this.db.withTransactionAsync',R005:'audio_uri',R006:'private replaceLocalSet',R007:'const { mobileSalt, companionSalt }',R008:'this.transport.handleAck',R009:'while let line = readLine()',R010:'async throws -> Data?',R011:'item.kind !== "user"',R012:'RevisionSchema.parse(revision)',R013:'const envelope = await this.postRpc',R014:'buffer.indexOf("\\n\\n")',R015:'const signal = new AbortController().signal',R016:'this.admit(record)',R017:'        engine.start()',R018:'if (promptRecord.node_errors)',R019:'value[1] === 0 ? modelSource : clipSource',R020:'RUN npm ci',R021:'private acceptSequence',R022:'for (const row of chunk) this.pending.delete',R023:'return batch.records.every'};
const evidence=[];
for(const finding of f){
 const body=fs.readFileSync(finding.file,'utf8');
 const lines=body.split(/\r?\n/);
 const needle=needles[finding.id];
 let indexes=lines.flatMap((line,i)=>line.includes(needle)?[i]:[]);
 if(finding.id==='R013') indexes=indexes.filter(i=>i>600);
 if(finding.id==='R016') indexes=indexes.filter(i=>i>180);
 if(finding.id==='R011' && !indexes.length) indexes=lines.flatMap((line,i)=>line.includes('part.kind !== "user"')?[i]:[]);
 if(!indexes.length) throw new Error('Recheck needle for '+finding.id+' '+needle);
 finding.line=indexes[0]+1;
 const excerpt=lines.slice(Math.max(0,indexes[0]-1),indexes[0]+3).join('\n');
 evidence.push({id:finding.id,file:finding.file,line:finding.line,sha256:createHash('sha256').update(body).digest('hex'),excerpt});
 console.log(finding.id+' '+finding.file+':'+finding.line+' '+excerpt.replaceAll('\n',' | '));
}
fs.writeFileSync(root+'findings.json',JSON.stringify(f,null,2)+'\n');
fs.writeFileSync(root+'source-audit.json',JSON.stringify({asOf:new Date().toISOString(),commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),worktree:'Includes uncommitted source; hashes identify exact finding files.',evidence},null,2)+'\n');
