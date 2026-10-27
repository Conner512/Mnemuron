// Connections page, organised by agent. Top: every connection in one table (ChatGPT connectors and authorizations, MCP
// tokens, plugin and adapter keys). Below: one setup panel per agent with standard steps; agents that can connect more
// than one way choose the way inside their own panel (e.g. ChatGPT runs as a web connector and needs nothing installed,
// Codex can use the Mnemuron plugin or plain MCP). A new credential is shown once and filled into the commands.
import {translate as t,syncAppearance} from './appearance.mjs';

const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const when=v=>{const n=typeof v==='number'?(v<1e12?v*1000:v):Date.parse(v||'');return n?new Date(n).toLocaleString('zh-CN',{dateStyle:'short',timeStyle:'short'}):'—';};
const STORE='mnm.agents.selection';

const PAT_STEP={id:'credential',title:'生成访问令牌',note:'选择只读或读写。令牌只显示这一次，默认 30 天有效，可随时轮换或撤销。'};
const KEY_STEP={id:'credential',title:'生成 Agent 密钥',note:'每台设备一把密钥，便于单独撤销。密钥只显示这一次。'};
const VERIFY={id:'verify',title:'验证',note:'在 agent 里让它“搜索一下我的记忆”。成功调用后，上方列表里的“最近活跃”会更新。'};
const keyFile=v=>`~/.mnemuron/credentials/${v.instance||'<实例 ID>'}.key`;
const saveKey=v=>({id:'key',title:'保存密钥',note:'写入只有你能读的文件，配置里只引用文件路径。',code:`mkdir -p ~/.mnemuron/credentials && (umask 077; printf '%s' '${v.key||'<生成后显示>'}' > ${keyFile(v)})`});

/** Agents and their ways of connecting. `credential` says what step 1 issues: chatgpt (OAuth client), pat (MCP token)
 * or key (plugin/adapter key). Steps get the server endpoints and, after step 1, the issued values. */
export const AGENTS=[
 {id:'chatgpt',name:'ChatGPT',note:'在 ChatGPT 网页和手机 App 里搜索、读取和保存记忆，本机不需要安装任何东西。',methods:[
  {id:'connector',label:'自定义连接器',badge:'推荐',detail:'在 ChatGPT 里添加一个 MCP 连接器，用 Mnemuron 账户登录授权。',credential:'chatgpt',steps:(e,v)=>[
   {id:'credential',title:'生成连接器凭证',note:'得到 Client ID 和 Client Secret。Secret 只显示这一次。'},
   {id:'create',title:'在 ChatGPT 创建连接器',note:'设置 → 应用与连接器 → 高级设置 → 打开开发者模式 → 创建。认证方式选 OAuth，填入下面三项。',
    code:`名称：Mnemuron\nMCP 服务器 URL：${e.mcp}\nClient ID：${v.client_id||'<生成后显示>'}\nClient Secret：${v.secret||'<生成后显示>'}`},
   {id:'callback',title:'确认回调地址',note:'已预填 ChatGPT 的标准回调地址。若 ChatGPT 显示的回调地址不同，在上方列表里点这个连接的“回调地址”修改。',code:'https://chatgpt.com/connector_platform_oauth_redirect'},
   {id:'authorize',title:'登录授权',note:'在 ChatGPT 对话里启用 Mnemuron 连接器，按提示用用户名、密码和动态验证码登录。授权后上方列表显示“已授权”。'}]}]},
 {id:'claude-code',name:'Claude Code',note:'在 Claude Code 里用 MCP 工具搜索、读取和保存记忆。',later:'带自动记录和会话接续的 Mnemuron 插件目前只支持 Codex，Claude Code 版本之后提供。',methods:[
  {id:'mcp',label:'MCP（远程）',badge:'推荐',detail:'一条命令接入，本机不需要安装插件。',credential:'pat',steps:(e,v)=>[PAT_STEP,
   {id:'add',title:'添加 MCP 服务器',note:'在终端运行，然后重启 Claude Code。',code:`claude mcp add --transport http mnemuron ${e.mcp_generic} --header "Authorization: Bearer ${v.token||'<生成后显示>'}"`},VERIFY]}]},
 {id:'codex',name:'Codex',note:'在 Codex 里使用记忆；装插件还能自动记录工作、会话开始时带上相关记忆、跨设备接续任务。',methods:[
  {id:'plugin',label:'Mnemuron 插件',badge:'推荐',detail:'自动记录、会话开始注入记忆、跨设备接续。需要在本机安装插件。',credential:'key',steps:(e,v)=>[KEY_STEP,saveKey(v),
   // The plugin resolves paths as given (no ~ expansion), so the shell writes absolute paths from $HOME.
   {id:'config',title:'写入插件配置',note:'在终端运行，生成 ~/.mnemuron/config.json（路径会展开成绝对路径）。',code:`cat > ~/.mnemuron/config.json <<EOF\n${JSON.stringify({mode:'remote',server_url:e.server,api_key_file:keyFile(v).replace('~','$HOME'),data_dir:'$HOME/.mnemuron/client',device_id:v.device||'<设备名>',agent_id:'codex',agent_instance_id:v.instance||'<实例 ID>',background_sync:true},null,2)}\nEOF`},
   {id:'install',title:'安装插件',note:'下载源码并链接到 Codex 的插件目录，然后在 Codex 里启用 Mnemuron 插件并重启。',code:'git clone https://github.com/Conner512/Mnemuron.git ~/Mnemuron\nmkdir -p ~/plugins && ln -sfn ~/Mnemuron/plugins/mnemuron ~/plugins/mnemuron'},
   {id:'verify',title:'验证',note:'在 Codex 里运行 /Mnemuron status，应显示远程模式和服务器确认的身份。'}]},
  {id:'mcp',label:'只接 MCP',detail:'不装插件，只用搜索、读取和保存工具。',credential:'pat',steps:(e,v)=>[PAT_STEP,
   {id:'config',title:'写入 Codex 配置',note:'加到 ~/.codex/config.toml。',code:`[mcp_servers.mnemuron]\nurl = "${e.mcp_generic}"\nbearer_token_env_var = "MNEMURON_TOKEN"`},
   {id:'env',title:'设置令牌',note:'加到 ~/.zshrc 或 ~/.bashrc，然后重开终端和 Codex。',code:`export MNEMURON_TOKEN="${v.token||'<生成后显示>'}"`},VERIFY]}]},
 {id:'cursor',name:'Cursor',note:'在 Cursor 的 Agent 里用 MCP 工具使用记忆。',methods:[
  {id:'mcp',label:'MCP（远程）',badge:'推荐',detail:'写一段 MCP 配置即可，本机不需要安装插件。',credential:'pat',steps:(e,v)=>[PAT_STEP,
   {id:'config',title:'写入 Cursor 配置',note:'保存为 ~/.cursor/mcp.json（已有内容时合并 mcpServers），然后重启 Cursor。',code:JSON.stringify({mcpServers:{mnemuron:{url:e.mcp_generic,headers:{Authorization:`Bearer ${v.token||'<生成后显示>'}`}}}},null,2)},VERIFY]}]},
 {id:'muse',name:'Muse',note:'在 Muse 里用 MCP 工具搜索、读取和保存记忆。',methods:[
  {id:'mcp',label:'MCP（远程）',badge:'推荐',detail:'在 Muse 的 MCP 设置里添加一个远程服务器，本机不需要安装插件。',credential:'pat',steps:(e,v)=>[PAT_STEP,
   {id:'config',title:'在 Muse 添加 MCP 服务器',note:'打开 Muse 的 MCP 设置，添加远程（Streamable HTTP）服务器，名称填 mnemuron，再填入地址和请求头；保存后重启 Muse。',
    code:`URL：${e.mcp_generic}\nAuthorization: Bearer ${v.token||'<生成后显示>'}`},VERIFY]}]},
 {id:'openclaw',name:'OpenClaw',note:'OpenClaw 通过 Mnemuron 适配器同步任务和记忆。',methods:[
  {id:'adapter',label:'Mnemuron 适配器',badge:'推荐',detail:'在 OpenClaw 所在机器安装适配器。',credential:'key',steps:(e,v)=>[KEY_STEP,saveKey(v),
   {id:'config',title:'配置适配器',note:'按 adapters/openclaw/README.md 安装，配置里填入这些值（api_key_file 要写成完整路径，例如 /Users/你的用户名/...）。',code:`server_url: ${e.server}\napi_key_file: ${keyFile(v)}\ndevice_id: ${v.device||'<设备名>'}\nagent_id: openclaw\nagent_instance_id: ${v.instance||'<实例 ID>'}`},VERIFY]}]},
 {id:'hermes',name:'Hermes',note:'Hermes 通过 Mnemuron 插件同步任务和记忆。',methods:[
  {id:'adapter',label:'Mnemuron 插件',badge:'推荐',detail:'在 Hermes 所在机器安装插件。',credential:'key',steps:(e,v)=>[KEY_STEP,saveKey(v),
   {id:'config',title:'配置插件',note:'写入 ~/.hermes/config.yaml（api_key_file 要写成完整路径），安装步骤见 adapters/hermes/README.md。',code:`plugins:\n  entries:\n    mnemuron:\n      settings:\n        server_url: ${e.server}\n        api_key_file: ${keyFile(v)}\n        device_id: ${v.device||'<设备名>'}\n        agent_id: hermes\n        agent_instance_id: ${v.instance||'<实例 ID>'}`},VERIFY]}]},
 {id:'other',name:'其他 MCP 客户端',note:'任何支持远程 MCP（Streamable HTTP）和 Bearer 令牌的客户端。',methods:[
  {id:'mcp',label:'MCP（远程）',detail:'填入地址和请求头即可。',credential:'pat',steps:(e,v)=>[PAT_STEP,
   {id:'config',title:'客户端配置',note:'传输方式选 Streamable HTTP。',code:`URL：${e.mcp_generic}\nAuthorization: Bearer ${v.token||'<生成后显示>'}`},VERIFY]}]},
];
const METHOD_NAMES={chatgpt_oauth:'连接器',generic_mcp:'MCP 令牌',key:'插件密钥',legacy:'旧版授权'};
const AGENT_OF_KEY={codex:'codex',chatgpt:'codex',openclaw:'openclaw',hermes:'hermes','claude-code':'claude-code'};
const agentName=id=>AGENTS.find(a=>a.id===id)?.name||id||'—';

// Page state kept between renders: selected agent and method, and the credential just issued (memory only).
const ui={agent:'chatgpt',method:{},issued:{}};
try{Object.assign(ui,JSON.parse(localStorage.getItem(STORE)||'{}'),{issued:{}});}catch{}
const remember=()=>{try{localStorage.setItem(STORE,JSON.stringify({agent:ui.agent,method:ui.method}));}catch{}};
let last={data:{},caps:{},extras:{},query:{}};

/** The selected connection page, plus matching legacy grants and agent keys. */
export function connectionRows(data,{section='active'}={}){
 const history=section==='history';
 const rows=[];
 for(const c of data.connections||[])if(history===(c.configuration_state==='revoked'||!!c.expired))rows.push({id:c.connection_id,source:'connection',agent:c.agent||(c.kind==='chatgpt_oauth'?'chatgpt':'other'),label:c.label,method:METHOD_NAMES[c.kind],
  access:c.profile==='memory_readwrite'?'读写':'只读',device:'—',created:c.created_at,last:c.last_successful_tool_at||c.last_authorized_at,
  state:c.configuration_state==='revoked'?'已撤销':c.expired?'已过期':c.configuration_state==='disabled'?'已停用':c.kind==='chatgpt_oauth'?(c.active_grant_count?'已授权':'待授权'):c.health==='verified'?'已验证':'未使用',
  revoked:c.configuration_state==='revoked',disabled:c.configuration_state==='disabled',kind:c.kind,redirect:c.redirect_uri});
 for(const g of history?[]:(data.legacy_connections||[]).flatMap(c=>c.grants||[]))rows.push({id:g.grant_id,source:'grant',agent:'chatgpt',label:'ChatGPT（旧版连接）',method:METHOD_NAMES.legacy,
  access:(g.scopes||[]).includes('memory:write')?'读写':'只读',device:'—',created:g.created,last:data.system_chatgpt?.last_token_at,state:'已授权'});
 for(const c of data.core_connections||[]){const scopes=Array.isArray(c.scopes)?c.scopes:[];
  const inactive=!!c.revoked_at||c.state==='revoked'||c.state==='expired'||!!c.expires_at&&Date.parse(c.expires_at)<=Date.now();
  if(history!==inactive||['mnemuron-console','chatgpt-web','mnemuron'].includes(c.agent_id))continue;
  rows.push({id:c.credential_id,source:'key',agent:AGENT_OF_KEY[c.agent_id]||c.agent_id,label:c.label,method:METHOD_NAMES.key,access:scopes.some(s=>s==='memory:write'||s==='capture:write')?'读写':'只读',
   device:c.device_id,created:c.created_at,last:c.last_used_at,revoked:!!c.revoked_at||c.state==='revoked',state:c.revoked_at||c.state==='revoked'?'已撤销':inactive?'已过期':c.last_used_at?'已验证':'未使用'});}
 return rows.sort((a,b)=>String(b.created??'').localeCompare(String(a.created??'')));
}
const rowActions=(r,can)=>{
 if(r.revoked)return '';
 const b=(act,label,danger)=>`<button type="button" class="quiet${danger?' danger':''}" data-agent-row="${esc(act)}" data-id="${esc(r.id)}" data-source="${esc(r.source)}">${label}</button>`;
 if(r.source==='grant')return can('oauth.revoke')?b('oauth.revoke','撤销',true):'';
 if(r.source==='key')return [can('devices.rotate')?b('devices.rotate','轮换'):'',can('devices.revoke')?b('devices.revoke','撤销',true):''].join('');
 return [r.kind==='chatgpt_oauth'?b('connections.update','回调地址'):'',b('connections.rotate','轮换'),b(r.disabled?'connections.enable':'connections.disable',r.disabled?'启用':'停用'),b('connections.revoke','撤销',true)].join('');
};
function connectedTable(data,caps,query){
 const rows=connectionRows(data,query),can=a=>caps.allowed_actions?.includes(a)||a.startsWith('connections.'),history=query.section==='history';
 return `<section class="card agents-connected"><header class="section-head"><h2>${history?'连接历史':'已连接'}</h2><small class="muted">本页 ${rows.length} 个</small></header>
  <form id="connection-filters" class="toolbar"><label>记录<select name="section"><option value="active"${history?'':' selected'}>当前连接</option><option value="history"${history?' selected':''}>过期和已撤销</option></select></label><label>连接器和 MCP 令牌名称<input name="search" maxlength="120" autocomplete="off" value="${esc(query.search||'')}"></label><div class="connection-filter-actions"><button type="submit">应用</button><button type="button" class="quiet" data-connection-reset>重置</button></div></form>
  ${history?'<p class="muted">过期的 MCP 令牌仍占用连接名额，可轮换后继续使用，或撤销以释放名额。已撤销的记录仅供查看。</p>':''}
  ${rows.length?`<div class="table-scroll"><table class="agents-table"><thead><tr><th>Agent</th><th>权限</th><th>方式</th><th>设备</th><th>创建</th><th>最近活跃</th><th>状态</th><th></th></tr></thead><tbody>${rows.map(r=>`<tr>
   <td><strong>${esc(agentName(r.agent))}</strong><small>${esc(r.label)}</small></td><td><span class="tag" data-access="${r.access==='读写'?'rw':'ro'}">${r.access}</span></td><td>${esc(r.method)}</td><td>${esc(r.device)}</td>
   <td>${when(r.created)}</td><td>${when(r.last)}</td><td><span class="tag" data-state="${esc(r.state)}">${esc(r.state)}</span></td><td class="row-actions">${rowActions(r,can)}</td></tr>`).join('')}</tbody></table></div>`
  :`<div class="agents-empty"><strong>${history?'没有匹配的历史记录':'没有匹配的当前连接'}</strong><p class="muted">${history?'可切换到当前连接查看正在使用的凭证。':'可查看过期和已撤销的记录，或在下方生成凭证并接入。'}</p></div>`}
  <div class="library-footer"><p>匹配的连接器和 MCP 令牌：${esc(data.total??0)} 个；旧版授权和 Agent 密钥单独列出。</p><div class="pagination">${data.offset?`<button type="button" data-connection-page="${Math.max(0,data.offset-(data.limit||20))}">上一页</button>`:''}${data.next_offset!=null?`<button type="button" data-connection-page="${data.next_offset}">下一页</button>`:''}</div></div></section>`;
}
function stepRows(agent,method,endpoints){
 const issued=ui.issued[`${agent.id}:${method.id}`]||{},v=issued.values||{};
 return method.steps(endpoints,v).map((s,i)=>`<li class="agent-step"><div><strong>${i+1}. ${esc(s.title)}</strong><p class="muted">${esc(s.note)}</p></div>
  <div>${s.id==='credential'?(issued.values?`<p class="agent-issued">已生成：<strong>${esc(issued.label)}</strong>${issued.expires?` · ${esc(issued.expires)}`:''}<br><span class="muted">凭证已填入下面的命令，离开或刷新页面后不再显示，请现在复制。</span></p>`
   :`<button type="button" class="primary" data-agent-generate="${esc(agent.id)}:${esc(method.id)}">生成</button>`)
   :s.code?`<div class="agent-code"><pre><code>${esc(s.code)}</code></pre><button type="button" class="quiet" data-agent-copy>复制</button></div>`:''}</div></li>`).join('');
}
function setupPanel(data,caps,extras){
 const origin=typeof location==='undefined'?'':location.origin,endpoints=data.capabilities?.endpoints||{server:origin,mcp:`${origin}/mcp`,mcp_generic:`${origin}/mcp/generic`};
 const agent=AGENTS.find(a=>a.id===ui.agent)||AGENTS[0],method=agent.methods.find(m=>m.id===ui.method[agent.id])||agent.methods[0];
 return `<section class="card agents-setup"><header class="section-head"><h2>接入 agent</h2></header>
  <div class="agent-picker" role="tablist">${AGENTS.map(a=>`<button type="button" role="tab" aria-selected="${a.id===agent.id}" data-agent-pick="${a.id}">${esc(a.name)}</button>`).join('')}</div>
  <div class="agent-panel" role="tabpanel"><p>${esc(agent.note)}</p>
   ${agent.methods.length>1?`<div class="agent-methods" role="radiogroup" aria-label="接入方式">${agent.methods.map(m=>`<button type="button" role="radio" aria-checked="${m.id===method.id}" data-agent-method="${agent.id}:${m.id}"><strong>${esc(m.label)}</strong>${m.badge?` <span class="tag">${esc(m.badge)}</span>`:''}<small>${esc(m.detail)}</small></button>`).join('')}</div>`
    :`<p class="agent-method-one"><strong>${esc(method.label)}</strong>${method.badge?` <span class="tag">${esc(method.badge)}</span>`:''} <span class="muted">${esc(method.detail)}</span></p>`}
   ${agent.later?`<p class="policy-box">${esc(agent.later)}</p>`:''}
   <ol class="agent-steps">${stepRows(agent,method,endpoints)}</ol>
   ${extras[`${agent.id}:${method.id}`]||extras[agent.id]?`<details class="agent-settings"><summary>${esc(agent.name)} 的设置</summary>${extras[`${agent.id}:${method.id}`]||extras[agent.id]}</details>`:''}</div></section>`;
}
/** Select an agent (and method) for the next render; tests use it, the page uses the picker. */
export function selectAgent(agent,method){ui.agent=agent;if(method)ui.method[agent]=method;}
/** The connections page body. `extras` holds per-agent settings (ChatGPT read and write rules, capture switches). */
export function agentsView(data,caps,extras={},query={}){
 last={data,caps,extras,query};
 return `<div data-agents-root>${connectedTable(data,caps,query)}${setupPanel(data,caps,extras)}</div>`;
}
const repaint=()=>{const root=document.querySelector('[data-agents-root]');if(root){root.outerHTML=agentsView(last.data,last.caps,last.extras,last.query);syncAppearance();}};

export function mountAgents({mutate,reload}){
 const dialog=document.createElement('dialog');dialog.className='agent-dialog';dialog.innerHTML='<form method="dialog"></form>';document.body.append(dialog);
 const form=dialog.querySelector('form');let pending=null;
 const password='<fieldset class="reauth"><legend>再次验证身份</legend><label>当前密码<input name="current_password" type="password" autocomplete="current-password" maxlength="1024" required></label></fieldset>';
 const open=(title,body,submit,onSubmit,{reauthenticate=true}={})=>{form.innerHTML=`<div class="dialog-header"><h2>${esc(title)}</h2><button type="button" data-close aria-label="关闭">×</button></div>${body}${reauthenticate?password:''}<p class="agent-error" role="alert" hidden></p><div class="actions"><button type="submit" class="primary">${esc(submit)}</button><button type="button" data-close>取消</button></div>`;pending=onSubmit;dialog.showModal();form.querySelector('input,select')?.focus();};
 const show=(title,html)=>{form.innerHTML=`<div class="dialog-header"><h2>${esc(title)}</h2><button type="button" data-close aria-label="关闭">×</button></div>${html}<div class="actions"><button type="button" class="primary" data-close>我已保存</button></div>`;pending=null;if(!dialog.open)dialog.showModal();};
 form.addEventListener('click',e=>{if(e.target.closest('[data-close]')){dialog.close();}
  const copy=e.target.closest('[data-agent-copy]');if(copy)void copyFrom(copy);});
 form.addEventListener('submit',async e=>{if(!pending)return;e.preventDefault();const fd=new FormData(form),error=form.querySelector('.agent-error'),button=form.querySelector('[type=submit]');
  button.disabled=true;error.hidden=true;try{await pending(fd);}catch(err){error.textContent=`没有完成：${t(err.message)||err.message}`;error.hidden=false;}finally{button.disabled=false;}});
 async function copyFrom(button){const code=button.parentElement.querySelector('code');try{await navigator.clipboard.writeText(code.textContent);button.textContent='已复制';setTimeout(()=>{button.textContent='复制';},1500);}catch{button.textContent='请手动复制';}}
 const op=()=>crypto.randomUUID();
 function generate(agentId,methodId){
  const agent=AGENTS.find(a=>a.id===agentId),method=agent.methods.find(m=>m.id===methodId),write=last.data.capabilities?.write_enabled!==false;
  const continuity=agentId==='codex'&&methodId==='plugin';
  const access=`<label>权限<select name="access"><option value="read">只读：搜索和读取</option>${write||method.credential==='key'?`<option value="write"${continuity?'':' selected'}>读写：还能保存和修正记忆</option>`:''}${continuity?'<option value="continuity" selected>插件完整功能：记忆、自动记录、创建与接续任务</option>':''}</select></label>`;
  const label=`<label>名称<input name="label" maxlength="80" required value="${esc(agent.name)}${method.credential==='key'?'':' · '+new Date().toLocaleDateString('zh-CN')}"></label>`;
  const device=method.credential==='key'?'<label>设备名<input name="device" maxlength="64" required pattern="[A-Za-z0-9][A-Za-z0-9._:-]{0,63}" placeholder="例如 macbook-pro" value=""></label>':'';
  open(`${agent.name} · ${method.label}`,label+device+access,'生成',async fd=>{
   const taskContinuity=continuity&&fd.get('access')==='continuity',rw=fd.get('access')==='write'||taskContinuity,key=`${agentId}:${methodId}`,name=String(fd.get('label')).trim();
   if(method.credential==='key'){
    const device=String(fd.get('device')).trim(),agentKey=agentId==='codex'?'codex':agentId;
    const r=await mutate('devices.register',{label:name,agent_id:agentKey,device_id:device,access:rw?'read_write':'read',...(taskContinuity?{task_continuity:true}:{}),current_password:fd.get('current_password')},op());
    ui.issued[key]={label:name,values:{key:r.api_key,instance:r.credential?.agent_instance_id,device}};
   }else{
    const kind=method.credential==='chatgpt'?'chatgpt_oauth':'generic_mcp';
    const r=await mutate('connections.create',{kind,agent:agentId==='chatgpt'?'chatgpt':agentId,label:name,profile:rw?'memory_readwrite':'readonly',
     ...(kind==='chatgpt_oauth'?{redirect_uri:'https://chatgpt.com/connector_platform_oauth_redirect'}:{}),current_password:fd.get('current_password')},op());
    ui.issued[key]={label:name,expires:r.expires_at?`有效期至 ${when(r.expires_at)}`:'',values:kind==='chatgpt_oauth'?{client_id:r.connection?.client_id,secret:r.secret}:{token:r.secret}};
   }
   dialog.close();await reload();
  });
 }
 function rowAction(action,id,source){
  const names={'connections.rotate':'轮换凭证','connections.disable':'停用连接','connections.enable':'启用连接','connections.revoke':'撤销连接','connections.update':'修改回调地址','devices.rotate':'轮换密钥','devices.revoke':'撤销密钥','oauth.revoke':'撤销授权'};
  const notes={'connections.rotate':'旧凭证立即失效，新凭证只显示一次。','connections.revoke':'撤销后这个连接不能再用，也不能恢复。','devices.rotate':'旧密钥立即失效，新密钥只显示一次。','devices.revoke':'撤销后这台设备不能再访问记忆。','oauth.revoke':'ChatGPT 需要重新授权才能访问。','connections.disable':'停用后暂时不能访问，可以再启用。','connections.enable':'启用后会生成新凭证。'};
  const body=action==='connections.update'?'<label>ChatGPT 显示的回调地址<input name="redirect_uri" type="url" required value="https://chatgpt.com/connector_platform_oauth_redirect"></label>':`<p>${esc(notes[action]||'')}</p>`;
  open(names[action]||action,body,'确认',async fd=>{
   const pw=fd.get('current_password');
   const payload=source==='key'?{agent_instance_id:undefined,credential_id:id}:source==='grant'?{grant_id:id}:{connection_id:id};
   if(action==='devices.revoke'){const row=(last.data.core_connections||[]).find(c=>c.credential_id===id);Object.assign(payload,{agent_instance_id:row?.agent_instance_id});delete payload.credential_id;}
   if(action==='connections.update')payload.redirect_uri=String(fd.get('redirect_uri')).trim();
   for(const k of Object.keys(payload))if(payload[k]===undefined)delete payload[k];
   const r=await mutate(action,{...payload,...(action==='oauth.revoke'?{}:{current_password:pw})},op());
   dialog.close();await reload();
   const secret=r.secret||r.api_key;
   if(secret)show(names[action],`<p>新凭证只显示这一次，请现在复制，并更新对应 agent 的配置。</p><div class="agent-code"><pre><code>${esc(secret)}</code></pre><button type="button" class="quiet" data-agent-copy>复制</button></div>`);
  },{reauthenticate:action!=='oauth.revoke'});
 }
 document.addEventListener('click',e=>{
  const pick=e.target.closest('[data-agent-pick]');if(pick){ui.agent=pick.dataset.agentPick;remember();repaint();return;}
  const method=e.target.closest('[data-agent-method]');if(method){const [a,m]=method.dataset.agentMethod.split(':');ui.method[a]=m;remember();repaint();return;}
  const gen=e.target.closest('[data-agent-generate]');if(gen){const [a,m]=gen.dataset.agentGenerate.split(':');generate(a,m);return;}
  const copy=e.target.closest('[data-agents-root] [data-agent-copy]');if(copy){void copyFrom(copy);return;}
  const row=e.target.closest('[data-agent-row]');if(row)rowAction(row.dataset.agentRow,row.dataset.id,row.dataset.source);
 });
}
