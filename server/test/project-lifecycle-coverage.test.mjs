// Supplementary static guard for the lifecycle coverage inventory: literal SQL read and write sites on the
// lifecycle-relevant tables, counted per file, must match docs/architecture/project-lifecycle-coverage.json.
// A difference means an access site was added or removed without reviewing project-lifecycle-coverage.md.
// It cannot see helper-mediated or dynamic SQL; the inventory lists those by hand.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT=path.resolve(import.meta.dirname,'../..');
export const LIFECYCLE_TABLES=['projects','tasks','memories','checkpoints','events','memory_revisions','memory_summaries','memory_summary_dependencies','memory_vector_documents',
  'task_reconciliation_proposals','task_canonical_revisions','task_bootstrap_previews','resumes','resolver_selections','console_project_state','project_lifecycle',
  'memory_entities','memory_entity_names','memory_entity_members','memory_entity_proposals','memory_entity_tombstones','memory_entity_queue_cursor'];
const DIRS=['server/lib','services/oauth/src','adapters','plugins/mnemuron/scripts','server/bin'];

export function sqlSites(root=ROOT){
  const files=[],walk=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,entry.name);
    if(entry.isDirectory()){if(!['node_modules','test','acceptance'].includes(entry.name))walk(full);}else if(full.endsWith('.mjs'))files.push(full);}};
  for(const dir of DIRS)if(fs.existsSync(path.join(root,dir)))walk(path.join(root,dir));
  const sites={};
  for(const file of files.sort()){
    const text=fs.readFileSync(file,'utf8');
    for(const table of LIFECYCLE_TABLES){
      const count=pattern=>(text.match(new RegExp(pattern,'gi'))||[]).length;
      const deletes=count(`\\bDELETE\\s+FROM\\s+${table}\\b`);
      const read=count(`\\b(FROM|JOIN)\\s+${table}\\b`)-deletes;
      const write=count(`\\b(INSERT(\\s+OR\\s+\\w+)?\\s+INTO|REPLACE\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+${table}\\b`);
      if(read||write)(sites[path.relative(root,file)]??={})[table]={read,write};
    }
  }
  return sites;
}

test('Lifecycle coverage inventory matches every literal SQL read and write site',()=>{
  const recorded=JSON.parse(fs.readFileSync(path.join(ROOT,'docs/architecture/project-lifecycle-coverage.json'),'utf8'));
  assert.deepEqual(sqlSites(),recorded.sites,'SQL access to lifecycle-relevant tables changed: review docs/architecture/project-lifecycle-coverage.md and update the JSON counts');
  assert.deepEqual(recorded.tables,LIFECYCLE_TABLES);
});
