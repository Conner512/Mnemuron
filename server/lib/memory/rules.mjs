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
      const match = line[0].match(/^\s*(?:[-*•]\s+|\d+[.)]\s+)?(目标|goal|事实|fact|结论|约束|constraint|决定|决策|decision|已完成|完成|completed|阻塞|blocker|未完成|remaining|todo|下一步|next\s+steps?)(?:\s*[\[（(]([^\]）)]{1,120})[\]）)])?\s*[:：]\s*(.+?)\s*$/iu);
      if (!match) continue;
      const memoryType=types.get(match[1].toLowerCase()),content=match[3];
      if (!memoryType || memoryType==='blocker' && /^(?:无|没有|无阻塞|none|no|nil|n\/a|-)$/iu.test(content)) continue;
      const start=line.index + line[0].lastIndexOf(content);
      found.push({event,memory_type:memoryType,topic:match[2]?.trim() || null,content,start,end:start+content.length,selector});
    }
  }
  return found;
}
