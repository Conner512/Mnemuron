import {createHash} from 'node:crypto';
import {object,id,number} from './state.mjs';
import {ValidationError,ConflictError,NotFoundError} from '../errors.mjs';
import {sanitizeGitRemote} from '../store/helpers.mjs';
import {protectTables} from '../lifecycle/protection.mjs';

// Console project and task editing for the common fields: project name and metadata lists, task title, goal,
// status and aliases. Every read and write is owner-bound and bounded by the existing Console transport
// (56 KiB per action, 256 KiB per response), so full metadata is never round-tripped:
//  - list fields change by explicit add/remove of whole values and are read in pages, so a stored
//    50 x 2048 array is never truncated, rewritten or sent whole;
//  - omitted fields keep their stored value: the server merges onto the full stored record, and a task's
//    progress, decisions, blockers, next steps, resources, workstreams and conflicts (including structured
//    objects) are retained exactly; the Console does not edit them;
//  - project edits carry a revision token over the full stored row, task edits the canonical version;
//  - Console archive is hiding in the Console only: projects, tasks, memories and agent access are untouched.
// Renaming a project changes the project row only. Tasks keep their stored project_name snapshot (part of
// their canonical hash) until a normal canonical write; views show the current project name.
export const PROJECT_LIST_FIELDS={aliases:2048,git_remotes:2048,repo_fingerprints:2048,path_hints:4096};
export const TASK_LIST_FIELDS={aliases:2048};
// Task fields kept exactly as stored by every Console edit and shown only as counts.
export const TASK_RETAINED_FIELDS=['progress','decisions','blockers','next_steps','resources','workstreams','conflicts'];
const LIST_MAX_ITEMS=50;
// Longest title/goal the Console edits in place; a longer stored value is shown as not editable here and kept.
export const TASK_EDIT_LIMITS={title:2000,goal:8000};
const TASK_STATUSES=['active','paused','completed','archived'];
const PREVIEW={items:5,chars:120};
// Longest name/status text a Console view returns; anything longer is cut for display and flagged incomplete.
const DISPLAY_LIMIT=200;
// Paged value reads stop at this many JSON bytes (the Console transport allows 256 KiB per response).
const VALUE_PAGE_BYTES=128*1024;
const chars=value=>[...String(value)];
const clip=(value,limit)=>{const c=chars(value);return {text:c.slice(0,limit).join(''),complete:c.length<=limit};};
const json=(value,fallback)=>{try{const parsed=JSON.parse(value);return Array.isArray(parsed)?parsed:fallback;}catch{return fallback;}};

export class ConsoleProjects {
  constructor(service){this.service=service;this.store=service.store;this.db=service.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS console_project_state(user_id TEXT NOT NULL,project_id TEXT NOT NULL,archived_at TEXT,revision INTEGER NOT NULL,PRIMARY KEY(user_id,project_id));`);
    protectTables(this.db,['console_project_state']);
    // Project search folds case beyond ASCII (NFKC + toLowerCase) and matches the name or any single alias.
    this.db.function('mnemuron_fold',{deterministic:true},value=>value==null?null:String(value).normalize('NFKC').toLowerCase());
  }
  // Normal Console reads and edits are live-only: a deleted project (or a task in one) is PROJECT_DELETED for its owner.
  project(user,projectId){id(projectId);const row=this.db.prepare('SELECT * FROM projects WHERE user_id=? AND project_id=?').get(user,projectId);
    if(!row)throw new NotFoundError('Project not found.','PROJECT_NOT_FOUND');this.requireLive(user,row.project_id,'project');return row;}
  task(user,taskId){id(taskId);const row=this.db.prepare('SELECT * FROM tasks WHERE user_id=? AND task_id=?').get(user,taskId);
    if(!row)throw new NotFoundError('Task not found.','TASK_NOT_FOUND');this.requireLive(user,row.project_id,'task');return row;}
  // PROJECT_DELETED only for an owned, effectively deleted project. A record whose parent project is dangling or another
  // owner's ('unavailable') is answered exactly like a missing record, matching the lists that already omit it.
  // Canonical project of an owned live project ID (itself unless merged).
  canonicalOf(user,projectId){return this.store.lifecycle.resolve(user,projectId).canonical_project_id;}
  // Project-level Console writes (edit, archive, unarchive) apply to canonical projects only. Through a merged source ID
  // they are refused without any change, so the source keeps its own stored metadata and archive state as history.
  requireCanonical(user,projectId){if(this.canonicalOf(user,projectId)!==projectId)throw new ConflictError('This project was merged into another project.','PROJECT_NOT_CANONICAL');}
  requireLive(user,projectId,kind='task'){
    const state=this.store.lifecycle.projectState(user,projectId);
    if(state==='deleted')throw new ConflictError('This project was deleted.','PROJECT_DELETED');
    if(state==='unavailable')throw kind==='project'?new NotFoundError('Project not found.','PROJECT_NOT_FOUND'):new NotFoundError('Task not found.','TASK_NOT_FOUND');
  }
  // Changes whenever any stored project field changes, including list values the client never loaded.
  revision(row){return createHash('sha256').update(JSON.stringify([row.project_id,row.name,row.aliases_json,row.git_remotes_json,row.repo_fingerprints_json,row.path_hints_json,row.updated_at])).digest('hex').slice(0,32);}
  archived(user,projectId){return this.db.prepare('SELECT archived_at FROM console_project_state WHERE user_id=? AND project_id=?').get(user,projectId)?.archived_at||null;}

  // One view at a time: active projects (default) or those archived in the Console. Paging and counts are
  // computed on the server per view, so a page is never filtered after it was cut.
  list(user,p,{lifecycle=false}={}){
    object(p,['offset','limit','archived','query']);const offset=Number(p.offset??0),limit=Number(p.limit??25);number(offset,0,1000000);number(limit,1,50);
    if(p.archived!==undefined&&!['true','false','any','deleted'].includes(p.archived))throw new ValidationError('Invalid archive view.','INVALID_CONSOLE_INPUT');
    if(p.query!==undefined&&(typeof p.query!=='string'||p.query.length>200))throw new ValidationError('Invalid project search.','INVALID_CONSOLE_INPUT');
    // A name or single-alias filter (merge-target search), applied in SQL before paging.
    const needle=p.query?.trim()?p.query.trim().normalize('NFKC').toLowerCase():null;
    if(p.archived==='deleted'){if(!lifecycle)throw new NotFoundError('Project view not found.','NOT_FOUND');return this.deletedList(user,{offset,limit,needle});}
    // 'any': active and Console-archived together (merge targets may be archived).
    const archivedView=p.archived==='true',anyView=p.archived==='any';
    // Both views list canonical live projects only: deleted projects (and their members) and merged sources are left
    // out in SQL before paging. A merged source's tasks count toward its canonical target; sources are listed by ID.
    const live=this.store.lifecycle.live(user),hidden=JSON.stringify([...live.dead,...Object.keys(live.canonical)]);
    const sources=Object.create(null);for(const [source,target] of Object.entries(live.canonical))if(!live.dead.has(source))(sources[target]||=[]).push(source);
    const membersOf=projectId=>[projectId,...(sources[projectId]||[]).sort()];
    const rows=this.db.prepare(`SELECT p.*,s.archived_at FROM projects p LEFT JOIN console_project_state s ON s.user_id=p.user_id AND s.project_id=p.project_id
      WHERE p.user_id=? AND (?=1 OR (s.archived_at IS NOT NULL)=?) AND p.project_id NOT IN (SELECT value FROM json_each(?))
        AND (? IS NULL OR instr(mnemuron_fold(p.name),?)>0 OR EXISTS (SELECT 1 FROM json_each(p.aliases_json) a WHERE instr(mnemuron_fold(a.value),?)>0))
      ORDER BY p.name,p.project_id LIMIT ? OFFSET ?`).all(user,anyView?1:0,archivedView?1:0,hidden,needle,needle,needle,limit+1,offset);
    const taskCount=projectId=>this.db.prepare('SELECT COUNT(*) n FROM tasks WHERE user_id=? AND project_id IN (SELECT value FROM json_each(?))').get(user,JSON.stringify(membersOf(projectId))).n;
    const archived=this.db.prepare('SELECT COUNT(*) n FROM console_project_state s JOIN projects p ON p.user_id=s.user_id AND p.project_id=s.project_id WHERE s.user_id=? AND s.archived_at IS NOT NULL AND p.project_id NOT IN (SELECT value FROM json_each(?))').get(user,hidden).n;
    const total=this.db.prepare('SELECT COUNT(*) n FROM projects WHERE user_id=? AND project_id NOT IN (SELECT value FROM json_each(?))').get(user,hidden).n;
    return {read_only:true,view:anyView?'any':archivedView?'archived':'active',offset,limit,next_offset:rows.length>limit?offset+limit:null,active_count:total-archived,archived_count:archived,
      ...(lifecycle?{deleted_count:this.deletedRows(user).length}:{}),...(needle?{query:needle}:{}),projects:rows.slice(0,limit).map(row=>{
      const counts=Object.fromEntries(Object.keys(PROJECT_LIST_FIELDS).map(f=>[f,json(row[`${f}_json`],[]).length]));
      const aliases=json(row.aliases_json,[]);
      const name=clip(row.name,DISPLAY_LIMIT);
      return {project_id:row.project_id,name:name.text,name_complete:name.complete,archived:!!row.archived_at,archived_at:row.archived_at||null,task_count:taskCount(row.project_id),
        ...(sources[row.project_id]?{merged_project_ids:sources[row.project_id].sort()}:{}),
        created_at:row.created_at,updated_at:row.updated_at,revision:this.revision(row),counts,
        // A short preview for the list only; full values come from the paged metadata-values view.
        alias_preview:aliases.slice(0,PREVIEW.items).map(a=>clip(a,PREVIEW.chars)),alias_preview_complete:aliases.length<=PREVIEW.items};
    })};
  }
  // Owner-only retained history: canonical deleted projects (a merged source of a deleted target is listed under it,
  // as it is restored with it). Read-only; restore is the re-authenticated projects.lifecycle_restore action.
  deletedRows(user){return this.db.prepare(`SELECT l.project_id,l.lifecycle_revision,l.updated_at FROM project_lifecycle l JOIN projects p ON p.user_id=l.user_id AND p.project_id=l.project_id
    WHERE l.user_id=? AND l.state='deleted' ORDER BY l.project_id`).all(user);}
  // The active and archived counts of the other two views (canonical live projects only).
  viewCounts(user){const live=this.store.lifecycle.live(user),hidden=JSON.stringify([...live.dead,...Object.keys(live.canonical)]);
    const archived=this.db.prepare('SELECT COUNT(*) n FROM console_project_state s JOIN projects p ON p.user_id=s.user_id AND p.project_id=s.project_id WHERE s.user_id=? AND s.archived_at IS NOT NULL AND p.project_id NOT IN (SELECT value FROM json_each(?))').get(user,hidden).n;
    const total=this.db.prepare('SELECT COUNT(*) n FROM projects WHERE user_id=? AND project_id NOT IN (SELECT value FROM json_each(?))').get(user,hidden).n;
    return {active_count:total-archived,archived_count:archived};}
  deletedList(user,{offset,limit,needle}){
    const L=this.store.lifecycle,all=this.deletedRows(user).map(row=>({...row,project:this.db.prepare('SELECT * FROM projects WHERE user_id=? AND project_id=?').get(user,row.project_id)}))
      .filter(r=>r.project&&(!needle||[r.project.name,...json(r.project.aliases_json,[])].some(v=>String(v).normalize('NFKC').toLowerCase().includes(needle))))
      .sort((a,b)=>a.project.name<b.project.name?-1:a.project.name>b.project.name?1:a.project_id<b.project_id?-1:1);
    const page=all.slice(offset,offset+limit);
    return {read_only:true,view:'deleted',retained_history:true,...(needle?{query:needle,matched_count:all.length}:{}),offset,limit,next_offset:all.length>offset+limit?offset+limit:null,
      ...this.viewCounts(user),deleted_count:this.deletedRows(user).length,projects:page.map(r=>{
      const members=L.members(user,r.project_id).map(m=>m.project_id),name=clip(r.project.name,DISPLAY_LIMIT);
      return {project_id:r.project_id,name:name.text,name_complete:name.complete,deleted:true,deleted_at:r.updated_at,archived:!!this.archived(user,r.project_id),
        merged_project_ids:members.filter(id=>id!==r.project_id).sort(),task_count:this.db.prepare('SELECT COUNT(*) n FROM tasks WHERE user_id=? AND project_id IN (SELECT value FROM json_each(?))').get(user,JSON.stringify(members)).n};
    })};
  }
  // Paged full values of one list field, so any stored value can be seen and removed without truncation.
  // A page ends at `limit` values or the byte budget, whichever comes first; a single value over the budget
  // is listed as too large, never cut.
  values(user,p){
    object(p,['kind','id','field','offset','limit']);const offset=Number(p.offset??0),limit=Number(p.limit??10);number(offset,0,10000);number(limit,1,10);
    const fields=p.kind==='project'?PROJECT_LIST_FIELDS:p.kind==='task'?TASK_LIST_FIELDS:null;
    if(!fields||!Object.hasOwn(fields,p.field))throw new ValidationError('Invalid metadata field.','INVALID_CONSOLE_INPUT');
    const row=p.kind==='project'?this.project(user,p.id):this.task(user,p.id),all=json(row[`${p.field}_json`],[]),items=[];
    let bytes=0,index=offset;
    for(;index<all.length&&items.length<limit;index++){
      const value=all[index],size=Buffer.byteLength(JSON.stringify(value));
      const entry=size>VALUE_PAGE_BYTES?{index,too_large:true,bytes:size}:{index,value};
      const entryBytes=entry.too_large?64:size;
      if(items.length&&bytes+entryBytes>VALUE_PAGE_BYTES)break;
      items.push(entry);bytes+=entryBytes;
    }
    // A merged source's own stored values stay readable (origin identity), labelled with its canonical project.
    const canonical=p.kind==='project'?this.canonicalOf(user,row.project_id):null;
    return {read_only:true,kind:p.kind,id:p.id,field:p.field,total:all.length,offset,limit,items,
      next_offset:index<all.length?index:null,revision:p.kind==='project'?this.revision(row):row.canonical_version,
      ...(canonical&&canonical!==row.project_id?{canonical_project_id:canonical}:{})};
  }
  taskDetail(user,p){
    object(p,['task_id']);const row=this.task(user,p.task_id),task=this.store.taskFromRow(row);
    const project=this.db.prepare('SELECT name FROM projects WHERE user_id=? AND project_id=?').get(user,row.project_id);
    const title=clip(task.title,TASK_EDIT_LIMITS.title),goal=clip(task.goal,TASK_EDIT_LIMITS.goal);
    // Display-only fields are bounded too (admin upserts accept very large stored values); the stored values
    // are never changed by this read. An unknown parent (no owned project row) is reported as null.
    const shown=value=>{const c=clip(String(value??''),DISPLAY_LIMIT);return {text:c.text,complete:c.complete};};
    const current=project?shown(project.name):null,snapshot=shown(task.project_name),status=shown(task.status);
    return {read_only:true,task_id:task.task_id,project_id:task.project_id,
      project_name:current?.text??null,project_name_complete:current?.complete??null,project_name_snapshot:snapshot.text,project_name_snapshot_complete:snapshot.complete,
      title:title.text,title_complete:title.complete,goal:goal.text,goal_complete:goal.complete,status:status.text,status_complete:status.complete,
      status_editable:TASK_STATUSES.includes(task.status),canonical_version:task.canonical_version,updated_at:task.updated_at,
      alias_count:task.aliases.length,
      // Retained, not editable in the Console: counts only, the stored values are kept exactly by every edit.
      retained:Object.fromEntries(TASK_RETAINED_FIELDS.map(f=>[f,task[f].length]))};
  }

  apply(auth,action,p){
    // Console archive is Console-only state and stays available. Project and task metadata belong to the
    // handoff module: while new handoff operations are disabled, their edits are refused like other writers.
    if(action==='projects.archive'||action==='projects.restore')return this.setArchived(auth,p,action==='projects.archive');
    this.store.handoffPolicy.requireNew();
    if(action==='projects.update')return this.updateProject(auth,p);
    if(action==='tasks.update')return this.updateTask(auth,p);
    throw new NotFoundError('Console action not found.');
  }
  // Explicit add/remove of whole values. Removing a value that is not stored means the client is stale.
  editList(current,field,limit,{add=[],remove=[]}){
    for(const list of [add,remove])if(!Array.isArray(list)||list.length>LIST_MAX_ITEMS||list.some(v=>typeof v!=='string'))throw new ValidationError('Invalid list change.','INVALID_CONSOLE_INPUT');
    const next=[...current];
    for(const value of remove){const index=next.indexOf(value);if(index<0)throw new ConflictError('A value changed; reload before saving.','FIELD_VALUE_NOT_FOUND');next.splice(index,1);}
    for(const raw of add){
      const value=field==='git_remotes'?sanitizeGitRemote(raw):raw.trim();
      if(!value||chars(value).length>limit)throw new ValidationError('Invalid list value.','INVALID_CONSOLE_INPUT');
      if(!next.includes(value))next.push(value);
    }
    // Adding past 50 values is refused; a longer stored list (older data) can still shrink.
    if(next.length>current.length&&next.length>LIST_MAX_ITEMS)throw new ConflictError('Too many values.','FIELD_FULL');
    return next;
  }
  changes(p,fields){
    const out={};for(const kind of ['add','remove']){if(p[kind]===undefined)continue;object(p[kind],Object.keys(fields));out[kind]=p[kind];}
    return out;
  }
  updateProject(auth,p){
    object(p,['project_id','expected_revision','name','add','remove']);const user=auth.user_id,row=this.project(user,p.project_id);this.requireCanonical(user,row.project_id);
    if(typeof p.expected_revision!=='string'||p.expected_revision!==this.revision(row))throw new ConflictError('Project changed; reload before saving.','PROJECT_VERSION_CHANGED');
    if(p.name!==undefined&&(typeof p.name!=='string'||!p.name.trim()||chars(p.name.trim()).length>200))throw new ValidationError('Invalid project name.','INVALID_CONSOLE_INPUT');
    const edits=this.changes(p,PROJECT_LIST_FIELDS),next={name:p.name===undefined?row.name:p.name.trim()};
    for(const [field,limit] of Object.entries(PROJECT_LIST_FIELDS)){
      const current=json(row[`${field}_json`],[]);
      next[field]=edits.add?.[field]||edits.remove?.[field]?this.editList(current,field,limit,{add:edits.add?.[field]||[],remove:edits.remove?.[field]||[]}):current;
    }
    const same=f=>JSON.stringify(next[f])===JSON.stringify(json(row[`${f}_json`],[]));
    if(next.name===row.name&&Object.keys(PROJECT_LIST_FIELDS).every(same))return {status:'unchanged',project_id:row.project_id,revision:this.revision(row)};
    // A new updated_at strictly after the stored one, so the revision token always moves.
    const updated=new Date(Math.max(Date.now(),Date.parse(row.updated_at)+1)).toISOString();
    const result=this.db.prepare(`UPDATE projects SET name=?,aliases_json=?,git_remotes_json=?,repo_fingerprints_json=?,path_hints_json=?,updated_at=?
      WHERE user_id=? AND project_id=? AND updated_at=?`).run(next.name,JSON.stringify(next.aliases),JSON.stringify(next.git_remotes),JSON.stringify(next.repo_fingerprints),JSON.stringify(next.path_hints),updated,user,row.project_id,row.updated_at);
    if(result.changes!==1)throw new ConflictError('Project changed; reload before saving.','PROJECT_VERSION_CHANGED');
    this.store.audit({auth,action:'project.update',targetType:'project',targetId:row.project_id,metadata:{source:'console',
      fields:['name',...Object.keys(PROJECT_LIST_FIELDS)].filter(f=>f==='name'?next.name!==row.name:!same(f))}});
    return {status:'saved',project_id:row.project_id,revision:this.revision(this.project(user,row.project_id)),tasks_rewritten:0};
  }
  setArchived(auth,p,archive){
    object(p,['project_id']);const user=auth.user_id,row=this.project(user,p.project_id);this.requireCanonical(user,row.project_id);const current=this.archived(user,row.project_id);
    const retained={tasks_retained:true,memories_retained:true,agent_access_changed:false,deleted:false,console_only:true};
    if(!!current===archive)return {status:'unchanged',project_id:row.project_id,archived:archive,...retained};
    this.db.prepare(`INSERT INTO console_project_state VALUES(?,?,?,1) ON CONFLICT(user_id,project_id) DO UPDATE SET archived_at=excluded.archived_at,revision=console_project_state.revision+1`)
      .run(user,row.project_id,archive?new Date().toISOString():null);
    this.store.audit({auth,action:archive?'project.console_archive':'project.console_restore',targetType:'project',targetId:row.project_id});
    return {status:archive?'archived':'restored',project_id:row.project_id,archived:archive,...retained};
  }
  updateTask(auth,p){
    object(p,['task_id','expected_canonical_version','title','goal','status','add','remove']);const user=auth.user_id,row=this.task(user,p.task_id);
    number(p.expected_canonical_version,1,2147483647);
    if(p.expected_canonical_version!==row.canonical_version)throw new ConflictError('Canonical Task changed; reload before saving.','TASK_VERSION_CHANGED');
    // Merge onto the full stored canonical task: every field the Console does not send keeps its value.
    const task=this.store.taskFromRow(row),candidate={...task};
    for(const field of ['title','goal']){if(p[field]===undefined)continue;
      if(typeof p[field]!=='string'||!p[field].trim()||chars(p[field]).length>TASK_EDIT_LIMITS[field])throw new ValidationError(`Invalid task ${field}.`,'INVALID_CONSOLE_INPUT');
      if(chars(task[field]).length>TASK_EDIT_LIMITS[field])throw new ConflictError('This field is too long to edit in the Console.','FIELD_TOO_LONG_TO_EDIT');
      candidate[field]=p[field];}
    if(p.status!==undefined){if(!TASK_STATUSES.includes(p.status))throw new ValidationError('Invalid task status.','INVALID_CONSOLE_INPUT');candidate.status=p.status;}
    const edits=this.changes(p,TASK_LIST_FIELDS);
    if(edits.add?.aliases||edits.remove?.aliases)candidate.aliases=this.editList(task.aliases,'aliases',TASK_LIST_FIELDS.aliases,{add:edits.add?.aliases||[],remove:edits.remove?.aliases||[]});
    // project_id and project_name stay exactly as stored: no reparenting and no rename of the parent project.
    // The shared canonical body runs inside the Console action's own transaction (no nested BEGIN), with its
    // canonical hash, revision, proposal staling and audit; an identical result is reported as unchanged.
    return this.store.writeUpsertedTask(auth,candidate,{decision:'console_edit'});
  }
}
