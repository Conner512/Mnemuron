import { hash } from './revisions.mjs';

export const EXTRACTION_VERSION = 'strict-labeled-statements-v2';
const types = new Map(Object.entries({目标:'goal',goal:'goal',事实:'fact',fact:'fact',结论:'fact',约束:'constraint',constraint:'constraint',
  决定:'decision',决策:'decision',decision:'decision',已完成:'completed',完成:'completed',completed:'completed',阻塞:'blocker',blocker:'blocker',
  未完成:'remaining',remaining:'remaining',todo:'remaining',下一步:'next_step','next step':'next_step','next steps':'next_step'}));
const normalize = value => String(value || '').toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
export function legacyFingerprint(c, content, topic) {
  return hash(JSON.stringify({schema:'automatic-structured-memory-v0.1',user_id:c.user_id,scope:c.scope,
    project_id:c.project_id || null,task_id:c.task_id || null,workstream_id:c.workstream_id || null,
    session_id:c.scope==='session'?c.session_id:null,memory_type:c.memory_type,topic_key:topic?normalize(topic):null,content:normalize(content)}));
}
export function labeledStatements(events) {
  const found = [];
  for (const event of events) {
    if (!['user_message','assistant_message'].includes(event.event_type) || event.expired_at
      || event.expires_at && Date.parse(event.expires_at)<=Date.now() || !event.content) continue;
    const decoded = JSON.parse(event.content);
    const field = typeof decoded === 'string' ? null : ['text','content','message','summary','output'].find(key=>typeof decoded?.[key]==='string');
    const text = typeof decoded === 'string' ? decoded : decoded?.[field] || '';
    const selector = typeof decoded === 'string' ? '$' : '$.'+field;
    let fenced = false;
    for (const line of text.matchAll(/[^\r\n]+/g)) {
      if (/^\s*```/.test(line[0])) { fenced=!fenced; continue; }
      if (fenced) continue;
      const match = line[0].match(/^\s*(?:[-*•]\s+|\d+[.)]\s+)?(?:\*\*|__)?(目标|goal|事实|fact|结论|约束|constraint|决定|决策|decision|已完成|完成|completed|阻塞|blocker|未完成|remaining|todo|下一步|next\s+steps?)(?:\s*[\[（(]([^\]）)]{1,120})[\]）)])?(?:\*\*|__)?\s*[:：](?:\*\*|__)?\s*(.+?)\s*$/iu);
      if (!match) continue;
      const memoryType=types.get(match[1].toLowerCase()),content=match[3];
      if (!memoryType || memoryType==='blocker' && /^(?:无|没有|无阻塞|none|no|nil|n\/a|-)$/iu.test(content)) continue;
      const start=line.index + line[0].lastIndexOf(content);
      found.push({event,memory_type:memoryType,topic:match[2]?.trim() || null,content,start,end:start+content.length,selector,
        version:/\*\*|__/.test(line[0].slice(0,start-line.index))?'markdown-labeled-statements-v1':EXTRACTION_VERSION});
    }
  }
  return found;
}

export function conversationStatements(events, policy, userId) {
  if(policy?.enabled!==true || !policy.user_ids?.includes(userId))return [];
  const after=Date.parse(policy.after);if(!Number.isFinite(after))return [];
  const found=[],maxChars=policy.max_chars ?? 600;
  for(const event of events) {
    if(event.user_id!==userId || event.event_type!=='user_message' || event.expired_at || !event.content
      || event.expires_at && Date.parse(event.expires_at)<=Date.now()
      || !(Date.parse(event.captured_at)>=after) || !(Date.parse(event.received_at)>=after))continue;
    const decoded=JSON.parse(event.content),field=typeof decoded==='string'?null:['text','content','message'].find(key=>typeof decoded?.[key]==='string');
    const text=typeof decoded==='string'?decoded:decoded?.[field];
    if(!text || text.length>4000 || /```|~~~|[?？]|(?:^|\n)\s*[>"“{[]/u.test(text)
      || /(?:请|帮我|能否|可否|怎么|为何|为什么|是否|假如|假设|如果|例如|示例|不要记|别记|不记录|可能|也许|预计|打算|希望|将会|据说|\b(?:delete|forget|please|could you|can you|would you|what|why|how|might|perhaps|suppose)\b)/iu.test(text)
      || /(?:api[ _-]?key|token|secret|password|bearer|private[ _-]?key|密码|密钥|口令|验证码|身份证|银行卡)|[A-Za-z0-9_+\/-]{32,}/iu.test(text))continue;
    for(const line of text.matchAll(/[^\r\n。！？.!?]+[。！？.!?]?/gu)) {
      const content=line[0].trim();
      if(content.length<8 || content.length>maxChars || found.filter(c=>c.event===event).length>=5)continue;
      // Only direct, affirmative observations. Questions, imperatives and quotations
      // are excluded above; these are user statements, never verified/canonical facts.
      if(!/(?:去了|抵达|到达|完成了|已经|部署在|使用的是|版本是|我(?:喜欢|习惯|住在|偏好)|我的.{1,24}是|\bI (?:prefer|live|work|went|visited|like)\b|\b(?:has arrived|is deployed|version is|completed)\b)/iu.test(content))continue;
      const start=line.index+line[0].indexOf(content);
      found.push({event,memory_type:'fact',topic:null,content,start,end:start+content.length,selector:field?'$.'+field:'$',
        version:'conservative-user-statements-v1',confidence:0.65,warnings:['Automatically retained direct user statement; not independently verified or canonical Task state.']});
    }
  }
  return found;
}
