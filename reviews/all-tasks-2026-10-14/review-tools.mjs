import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const out = path.join(root, 'reviews/all-tasks-2026-10-14');
const walk = (dir) => fs.existsSync(dir) ? fs.readdirSync(dir, {withFileTypes:true}).flatMap(e => e.isDirectory() && !['node_modules','.git','target','.next'].includes(e.name) ? walk(path.join(dir,e.name)) : e.isFile() ? [path.join(dir,e.name)] : []) : [];
const relative = p => path.relative(root,p).replaceAll('\\','/');
const cards = [...walk(path.join(root,'plans/tasks')), ...walk(path.join(root,'handoffs/qwen3.8-flash-next-2026-10-08/tasks'))].filter(p=>p.endsWith('.md'));
const tasks = cards.map(p=> {
  const body=fs.readFileSync(p,'utf8');
  const id=body.match(/^id: (\S+)/m)?.[1] ?? path.basename(p).match(/^(C\d+)/)?.[1];
  const title=body.match(/^# (.+)/m)?.[1] ?? path.basename(p);
  const owned=(body.match(/\*\*Owned paths\/areas\*\*\r?\n([\s\S]*?)\r?\n\r?\n/)?.[1]??'').split(/\r?\n/).map(s=>s.replace(/^- /,'').trim()).filter(Boolean);
  const source=owned.flatMap(p=>fs.existsSync(path.join(root,p)) ? fs.statSync(path.join(root,p)).isDirectory() ? walk(path.join(root,p)) : [path.join(root,p)] : []).filter(p=>!/(?:\.test\.|\/test\/|\\test\\|fixtures|Tests|\.lock$|\.png$|\.json$)/.test(p)).map(relative);
  return {id,title,card:relative(p),phase:body.match(/^phase: (\S+)/m)?.[1]??'continuation',owned,existingOwned:owned.filter(p=>fs.existsSync(path.join(root,p))),source};
}).sort((a,b)=>a.id.localeCompare(b.id));
fs.writeFileSync(path.join(out,'inventory.json'),JSON.stringify(tasks,null,2)+'\n');
const statePath=path.join(out,'review-state.json');
if(!fs.existsSync(statePath)) fs.writeFileSync(statePath,JSON.stringify({asOf:new Date().toISOString(),scope:'All task cards. Source review for blockers, crashes, severe data loss, and core feature disabling defects. No implementation fixes or test execution.',reviewed:{},findings:[]},null,2)+'\n');
const state=JSON.parse(fs.readFileSync(statePath,'utf8'));
if(process.argv[2]==='list') {
  for(const t of tasks.filter(t=>!process.argv[3]||t.phase===process.argv[3])) console.log(`${t.id} | ${t.title} | ${t.existingOwned.join(';')} | ${t.source.length} files | ${state.reviewed[t.id]?.status??'pending review'}`);
} else if(process.argv[2]==='sizes') {
  for(const p of [...new Set(tasks.flatMap(t=>t.source))].filter(p=>/\.(ts|tsx|js|mjs|rs|swift|sql)$/.test(p))) console.log(`${fs.readFileSync(p,'utf8').split('\n').length} ${p}`);
}
