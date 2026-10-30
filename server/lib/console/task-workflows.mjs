// Console project/task bootstrap and canonical reconciliation. The owner reviews a frozen, credential-bound
// preview; every confirmation uses those server-side targets, never an Agent identity or session from the browser.
// Operation receipts contain identifiers only. Content is read separately under current credential/lifecycle checks.
import {createHash,randomUUID} from 'node:crypto';
import {consoleWritable,CONSOLE_WRITE_SCOPES,exactScopes,TASK_WORKFLOW_ACTIONS,TASK_WORKFLOW_VIEWS} from '../../../shared/console-contract.mjs';
import {AuthenticationError,AuthorizationError,ConflictError,NotFoundError,ValidationError} from '../errors.mjs';
import {TASK_BOOTSTRAP_PREVIEW_TTL_MS} from '../store/helpers.mjs';
import {object,id,number} from './state.mjs';

export {TASK_WORKFLOW_ACTIONS,TASK_WORKFLOW_VIEWS};
const KINDS={'projects.bootstrap_preview':'project_bootstrap','projects.bootstrap_confirm':'project_bootstrap','tasks.bootstrap_preview':'task_bootstrap','tasks.bootstrap_confirm':'task_bootstrap','tasks.reconciliation_preview':'reconciliation','tasks.reconciliation_resolve':'reconciliation'};
const FIELDS={
  'projects.bootstrap_preview':['project_name','task_title','task_goal','project_aliases','task_aliases','git_remotes','repo_fingerprints','path_hints','workstream_name'],
  'tasks.bootstrap_preview':['project_id','title','goal','aliases','workstream_name'],
  'tasks.reconciliation_preview':['task_id','source_checkpoint_ids'],
  'projects.bootstrap_confirm':['preview_id','preview_version','confirmed'],
  'tasks.bootstrap_confirm':['preview_id','preview_version','confirmed'],
  'tasks.reconciliation_resolve':['preview_id','preview_version','decision'],
};
const PREVIEW_BYTES=192*1024;
const changed=()=>new ConflictError('This preview changed. Review a fresh preview.','PREVIEW_CHANGED');
const identityKeys=['user_id','credential_id','agent_id','device_id','agent_instance_id'];
const parse=value=>JSON.parse(value);

export class ConsoleTaskWorkflows {
  constructor(service){this.service=service;this.store=service.store;this.db=service.db;this.clock=()=>Date.now();
    // Additive Console state, deliberately separate from console_operations: replay never returns this JSON.
    this.db.exec(`CREATE TABLE IF NOT EXISTS console_task_workflow_previews(
      preview_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,credential_id TEXT NOT NULL,kind TEXT NOT NULL,
      preview_version INTEGER NOT NULL,generation INTEGER NOT NULL,preview_json TEXT NOT NULL,references_json TEXT NOT NULL,
      created_at TEXT NOT NULL,expires_at TEXT NOT NULL,decision TEXT,result_json TEXT);`);
  }
  require(auth){
    if(!consoleWritable(auth))throw new AuthorizationError('console:write');
    this.service.require(auth,'tasks.reconciliation_preview');
    const row=this.db.prepare('SELECT * FROM credentials WHERE user_id=? AND credential_id=?').get(auth.user_id,auth.credential_id);
    if(!row||row.revoked_at||row.expires_at&&Date.parse(row.expires_at)<=this.clock()
      ||identityKeys.some(key=>row[key]!==auth[key])||!exactScopes(parse(row.scopes_json),CONSOLE_WRITE_SCOPES))throw new AuthenticationError();
  }
  // A finite internal delegation after the exact full-Console check above. All authenticated identity fields stay
  // unchanged; the copy is used only for this named Core operation and is never stored as a credential.
  actor(auth,scope){return {...auth,scopes:[scope]};}
  row(auth,previewId){id(previewId);const row=this.db.prepare('SELECT * FROM console_task_workflow_previews WHERE user_id=? AND credential_id=? AND preview_id=?').get(auth.user_id,auth.credential_id,previewId);
    if(!row)throw new NotFoundError('Task workflow preview not found.','PREVIEW_REQUIRED');return row;}
  references(auth,row){
    const refs=parse(row.references_json),user=auth.user_id;
    for(const project of refs.projects)this.service.projects.project(user,project);
    for(const task of refs.tasks)this.service.projects.task(user,task);
    if(refs.checkpoints.length)this.store.reconciliationCheckpoints(auth,refs.checkpoint_task,refs.checkpoints);
    // A successfully created project/task was not an existing source when the preview was made. It becomes a live
    // target now, including on lost-response retries; an old receipt cannot revive a deleted target.
    if(row.result_json){const result=parse(row.result_json);if(result.project_id)this.service.projects.project(user,result.project_id);if(result.task_id)this.service.projects.task(user,result.task_id);}
  }
  frozen(auth,row){
    this.references(auth,row);
    if(row.generation!==this.store.lifecycle.generation(auth.user_id))throw new ConflictError('A project lifecycle change happened after this preview. Review it again.','LIFECYCLE_AUTHORITY_STALE');
    if(Date.parse(row.expires_at)<=this.clock())throw new ConflictError('This preview expired. Review it again.','PREVIEW_EXPIRED');
    return parse(row.preview_json);
  }
  bootstrap(auth,preview){
    const row=this.db.prepare('SELECT * FROM task_bootstrap_previews WHERE user_id=? AND requested_by_credential_id=? AND bootstrap_id=?').get(auth.user_id,auth.credential_id,preview.bootstrap_id);
    if(!row)throw new NotFoundError('Task workflow preview not found.','PREVIEW_REQUIRED');
    const stored=parse(row.preview_json);
    if(row.preview_version!==preview.preview_version||stored.target_session_id!==preview.target_session_id
      ||stored.task.task_id!==preview.task.task_id||stored.project.project_id!==preview.project.project_id)throw changed();
    return row;
  }
  proposal(auth,preview){
    const saved=preview.proposal,row=this.db.prepare('SELECT * FROM task_reconciliation_proposals WHERE user_id=? AND proposal_id=?').get(auth.user_id,saved.proposal_id);
    if(!row)throw new NotFoundError('Reconciliation proposal not found.','PREVIEW_REQUIRED');
    if(row.task_id!==saved.task_id||row.proposal_version!==saved.proposal_version||row.base_canonical_version!==saved.base_canonical_version)throw changed();
    this.service.projects.requireLive(auth.user_id,row.project_id);
    this.service.projects.task(auth.user_id,row.task_id);
    return this.store.reconciliationProposalFromRow(row);
  }
  async execute(auth,action,p,operation){
    this.require(auth);if(!TASK_WORKFLOW_ACTIONS.includes(action))throw new NotFoundError('Action not found.');
    id(operation);object(p,FIELDS[action]);if(Buffer.byteLength(JSON.stringify(p))>56*1024)throw new ValidationError('Request too large.','CONSOLE_INPUT_TOO_LARGE');
    const creating=action.endsWith('_preview');
    if(!creating){id(p.preview_id);number(p.preview_version,1,2147483647);
      if(action==='tasks.reconciliation_resolve'?!['confirm','reject'].includes(p.decision):typeof p.confirmed!=='boolean')throw new ValidationError('Choose whether to confirm this exact preview.','INVALID_CONSOLE_INPUT');}
    return this.store.memoryTransaction(()=>{
      // Validate before ConsoleState's existing-operation fast path. Receipts themselves are content-free, but a
      // foreign/revoked credential or deleted source must not turn replay into a fresh authorization.
      this.require(auth);
      let row;
      if(!creating){row=this.row(auth,p.preview_id);if(row.kind!==KINDS[action]||row.preview_version!==p.preview_version)throw changed();this.references(auth,row);}
      return this.service.state.sync(auth,action,p,operation,()=>creating?this.preview(auth,action,p,operation):this.resolve(auth,action,p,row));
    });
  }
  preview(auth,action,p,operation){
    this.store.handoffPolicy.requireNew();const user=auth.user_id,generation=this.store.lifecycle.generation(user),kind=KINDS[action];
    const refs={projects:[],tasks:[],checkpoints:[],checkpoint_task:null};let preview;
    // This is a Console-owned workstream, not a claim to an existing Agent session. The real authenticated actor
    // remains visible in Core provenance. A retry of the same Console operation uses the same local context.
    const context=createHash('sha256').update(JSON.stringify([user,auth.credential_id,operation])).digest('hex').slice(0,32);
    const binding={session_id:`console-session-${context}`,workstream_id:`console-workstream-${context}`,workstream_name:p.workstream_name??'Console'};
    if(kind==='project_bootstrap'){
      preview=this.store.createProjectBootstrapPreview(this.actor(auth,'project:bootstrap:preview'),{...p,...binding});
      if(preview.status==='existing_project_selection_required')refs.projects=preview.candidates.map(c=>c.project_id);
    }else if(kind==='task_bootstrap'){
      const project=this.service.projects.project(user,p.project_id);this.service.projects.requireCanonical(user,project.project_id);refs.projects=[project.project_id];
      const {project_id,...fields}=p;
      preview=this.store.createTaskBootstrapPreview(this.actor(auth,'task:bootstrap:preview'),{...fields,project_query:project_id,signals:{project_id},...binding});
      if(preview.status==='existing_task_selection_required')refs.tasks=preview.candidates.map(c=>c.task_id);
    }else{
      const task=this.service.projects.task(user,p.task_id);refs.projects=[task.project_id];refs.tasks=[task.task_id];
      preview=this.store.runReconciliation(this.actor(auth,'task:reconcile:read'),task.task_id,
        p.source_checkpoint_ids===undefined?{}:{source_checkpoint_ids:p.source_checkpoint_ids},{allowAutomatic:false});
      // Existing proposals are frozen too. Sources of a moved task remain subject to their own project lifecycle.
      this.proposal(auth,preview);refs.checkpoints=preview.proposal.source_checkpoint_ids;refs.checkpoint_task=task.task_id;
      if(refs.checkpoints.length)this.store.reconciliationCheckpoints(auth,task.task_id,refs.checkpoints);
    }
    const json=JSON.stringify(preview);if(Buffer.byteLength(json)>PREVIEW_BYTES)throw new ConflictError('This preview is too large to review completely. Choose fewer source checkpoints.','TASK_WORKFLOW_PREVIEW_TOO_LARGE');
    const now=this.clock(),expires=Math.min(now+TASK_BOOTSTRAP_PREVIEW_TTL_MS,preview.expires_at?Date.parse(preview.expires_at):Infinity),previewId=randomUUID();
    this.db.prepare('INSERT INTO console_task_workflow_previews VALUES(?,?,?,?,1,?,?,?,?,?,NULL,NULL)').run(previewId,user,auth.credential_id,kind,generation,json,JSON.stringify(refs),new Date(now).toISOString(),new Date(expires).toISOString());
    return {status:preview.status,preview_id:previewId,preview_version:1,kind,expires_at:new Date(expires).toISOString()};
  }
  resolve(auth,action,p,row){
    this.store.handoffPolicy.requireNew();const decision=action==='tasks.reconciliation_resolve'?p.decision:p.confirmed?'confirm':'cancel';
    // A completed preview has its own small receipt even if the caller used a fresh Console operation ID. Do not
    // reapply the proposal or recompute a result from a later canonical revision.
    if(row.result_json){if(row.decision!==decision)throw changed();return {...parse(row.result_json),idempotent:true};}
    const preview=this.frozen(auth,row);let result,receipt;
    if(row.kind==='reconciliation'){
      const proposal=this.proposal(auth,preview);
      if(proposal.status!=='awaiting_confirmation')throw changed();
      if(decision==='confirm'){
        this.store.assertProposalAuthority(auth,proposal);
        if(this.service.projects.task(auth.user_id,proposal.task_id).canonical_version!==proposal.base_canonical_version)throw new ConflictError('The canonical task changed. Review a fresh proposal.','TASK_VERSION_CHANGED');
        if(proposal.conflicts.length)throw new ConflictError('This proposal contains unresolved conflicts. Reject it before generating a replacement.','RECONCILIATION_CONFLICT');
      }
      result=this.store.resolveReconciliation(this.actor(auth,'task:reconcile:confirm'),proposal.proposal_id,{proposal_version:proposal.proposal_version,base_canonical_version:proposal.base_canonical_version,decision});
      receipt={status:result.status,proposal_id:proposal.proposal_id,task_id:proposal.task_id,project_id:proposal.project_id,
        ...(result.revision?{revision_id:result.revision.revision_id,canonical_version:result.revision.canonical_version_after}:{})};
    }else{
      if(!preview.requires_confirmation||!preview.bootstrap_id)throw new ConflictError('Select an existing project or task, or review a new preview.','PREVIEW_CHANGED');
      const core=this.bootstrap(auth,preview);this.store.assertBootstrapAuthority(auth,core);
      const project=row.kind==='project_bootstrap',scope=project?'project:bootstrap:confirm':'task:bootstrap:confirm';
      result=this.store[project?'confirmProjectBootstrap':'confirmTaskBootstrap'](this.actor(auth,scope),preview.bootstrap_id,preview.preview_version,p.confirmed,preview.target_session_id);
      receipt={status:result.status,bootstrap_id:preview.bootstrap_id,...(result.binding_packet?{project_id:result.binding_packet.project.project_id,task_id:result.binding_packet.task.task_id,canonical_version:result.binding_packet.task.canonical_version}:{})};
    }
    receipt={...receipt,preview_id:row.preview_id,preview_version:row.preview_version,kind:row.kind,decision};
    this.db.prepare('UPDATE console_task_workflow_previews SET decision=?,result_json=? WHERE user_id=? AND preview_id=? AND result_json IS NULL').run(decision,JSON.stringify(receipt),auth.user_id,row.preview_id);
    return receipt;
  }
  read(auth,view,p){
    this.require(auth);if(!TASK_WORKFLOW_VIEWS.includes(view))throw new NotFoundError('View not found.');object(p,['preview_id']);
    // The transaction makes credential, source and generation checks one consistent read with the frozen content.
    return this.store.memoryTransaction(()=>{
      this.require(auth);const row=this.row(auth,p.preview_id),preview=this.frozen(auth,row);let status=preview.status,confirm=false,reject=false,cancel=false;
      if(row.kind==='reconciliation'){
        const proposal=this.proposal(auth,preview);status=proposal.status;
        reject=status==='awaiting_confirmation';
        confirm=reject&&!proposal.conflicts.length&&this.store.authorityCurrent(auth.user_id,'reconciliation',proposal.proposal_id)
          &&this.service.projects.task(auth.user_id,proposal.task_id).canonical_version===proposal.base_canonical_version;
      }else if(preview.bootstrap_id){
        const core=this.bootstrap(auth,preview);status=core.status;
        confirm=cancel=status==='pending_confirmation'&&this.store.authorityCurrent(auth.user_id,row.kind==='project_bootstrap'?'project_bootstrap':'task_bootstrap',core.bootstrap_id);
      }
      if(row.result_json)status=parse(row.result_json).status;
      const enabled=this.store.handoffPolicy.enabled();
      return {read_only:true,production_ready:false,preview_id:row.preview_id,preview_version:row.preview_version,kind:row.kind,status,expires_at:row.expires_at,
        can_confirm:confirm&&enabled,can_reject:reject&&enabled,can_cancel:cancel&&enabled,blockers:enabled?[]:['HANDOFF_DISABLED'],preview};
    });
  }
}
