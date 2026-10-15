// Query-time relevance only: the lossless v3 token projection and stored memories stay intact.
export const normalizeSearch = value => String(value ?? '').normalize('NFKC').toLowerCase();
export function searchTokens(value) {
  const text=normalizeSearch(value),tokens=new Set();
  for(const segment of text.split(/(\p{Script=Han}+)/u)) {
    if(/^\p{Script=Han}/u.test(segment)) {
      const chars=Array.from(segment);chars.forEach((char,i)=>{tokens.add(char);if(chars[i+1])tokens.add(char+chars[i+1]);});
    } else for(const word of segment.match(/[\p{L}\p{N}]+(?:[._:/-][\p{L}\p{N}]+)*/gu)||[]) {
      tokens.add(word);for(const part of word.split(':'))tokens.add(part);
    }
  }
  for(const symbol of text.match(/\p{S}/gu)||[])tokens.add(symbol);
  return [...tokens];
}
const stopWords=new Set('a an the of to in on for and or is are was were what which how please find search show me my about tell'.split(' '));
const hanStopWords=new Set(['我','你','吗','呢','了','的','是']);
const segmenter=new Intl.Segmenter('zh',{granularity:'word'});
export function queryGroups(value) {
  // Segment only the particle: never remove 的 from a noun such as 目的地.
  const particles=[...segmenter.segment(normalizeSearch(value))].map(part=>part.segment==='的'?' ':part.segment).join('');
  const text=particles.replace(/请帮我|帮我|帮忙|查一下|找一下|我想知道|告诉我|查询|搜索|查看|有关|关于|哪些|哪个|如何|怎么|是否/gu,' ');
  const groups=[];
  for(const segment of text.split(/(\p{Script=Han}+)/u)) {
    if(/^\p{Script=Han}/u.test(segment)) {
      if(hanStopWords.has(segment))continue;
      const chars=Array.from(segment);groups.push(chars.length===1?chars:[...new Set(chars.slice(1).map((c,i)=>chars[i]+c))]);
    } else for(const token of searchTokens(segment))if(!stopWords.has(token))groups.push([token]);
  }
  return groups;
}
export const queryTokens=value=>[...new Set(queryGroups(value).flat())];
const escaped=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
function termPattern(term) {
  const first=Array.from(term)[0],last=Array.from(term).at(-1);
  // Han/Latin adjacency is a word boundary; punctuation inside an identifier is not.
  const left=first&&!/\p{Script=Han}/u.test(first)&&/[\p{L}\p{N}]/u.test(first)?'(?<![\\p{L}\\p{N}_./-](?<![\\p{Script=Han}]))':'';
  // Use ASCII/other non-Han letters for identifiers; a sentence-final full stop is allowed.
  const right=last&&!/\p{Script=Han}/u.test(last)&&/[\p{L}\p{N}]/u.test(last)?'(?![A-Za-z0-9_/-]|\\.[A-Za-z0-9])':'';
  return new RegExp(left+escaped(term)+right,'gu');
}
export function containsTerm(text,term) {
  text=normalizeSearch(text);term=normalizeSearch(term).trim();
  if(!term)return false;
  // Token membership closes prefix collisions, including Unicode Latin identifiers.
  if(!/\p{Script=Han}/u.test(term)&&!/\s/u.test(term)&&/[\p{L}\p{N}]/u.test(term))return new Set(searchTokens(text)).has(term);
  return termPattern(term).test(text);
}
function literalScore(query,text) {
  if(containsTerm(text,query))return 1;
  const groups=queryGroups(query),present=new Set(searchTokens(text));
  if(!groups.length)return 0;
  const coverage=groups.map(group=>group.filter(token=>present.has(token)).length/group.length);
  // A shared Han character or one unrelated keyword cannot be rescued by recency/confidence.
  if(coverage.some(value=>value<2/3))return 0;
  return coverage.reduce((a,b)=>a+b,0)/coverage.length*0.8;
}
export function aliasAnchorsMatch(plan,text) {return (plan?.anchors||[]).every(group=>group.some(term=>containsTerm(text,term)));}
export function lexicalScore(query,memory,plan) {
  const text=normalizeSearch(`${memory.content||''}\n${memory.topic||''}`);
  if(!aliasAnchorsMatch(plan,text))return 0;
  return Math.max(0,...(plan?.queries||[query]).map((q,i)=>literalScore(normalizeSearch(q).trim(),text)*(i?0.96:1)));
}

// Only explicit name equivalences, never generated synonym guesses or recursive expansion.
export function declaredAliases(value) {
  const text=normalizeSearch(value),groups=[];
  const han='[\\p{Script=Han}]{2,16}',latin='[a-z][a-z0-9._-]{1,47}';
  for(const re of [new RegExp(`(${han})\\s*\\(\\s*(${latin})\\s*\\)`,'gu'),new RegExp(`(${latin})\\s*\\(\\s*(${han})\\s*\\)`,'gu'),
    new RegExp(`(${han}|${latin})\\s*(?:又称|也叫|别名为|简称为|别名|简称|\\baka\\b|\\balso known as\\b)\\s*[:：]?\\s*(${han}|${latin})`,'gu')]) {
    for(const match of text.matchAll(re))if(match[1]!==match[2]&&groups.length<16)groups.push([match[1],match[2]]);
  }
  return groups;
}
export function makeQueryPlan(query,groups=[],sourceTruncated=false) {
  query=normalizeSearch(query).trim();
  if(sourceTruncated)return {queries:[query],anchors:[],expanded:false,ambiguous:false,source_truncated:true};
  const unique=[...new Map(groups.map(group=>{const terms=[...new Set(group.map(normalizeSearch).map(s=>s.trim()).filter(s=>s.length>=2&&s.length<=120))].sort();return [JSON.stringify(terms),terms];})).values()].filter(g=>g.length>1);
  const matches=new Map();
  for(const group of unique)for(const term of group)if(containsTerm(query,term)) {const bucket=matches.get(term)||[];bucket.push(group);matches.set(term,bucket);}
  let queries=[query],ambiguous=false;const anchors=[];
  for(const [term,candidates] of [...matches].sort((a,b)=>b[0].length-a[0].length)) {
    if(candidates.length!==1){ambiguous=true;continue;}
    const group=candidates[0];if(anchors.some(a=>a.includes(term)))continue;
    anchors.push(group);
    const expanded=[];for(const q of queries)for(const alternative of group)expanded.push(q.replace(termPattern(term),alternative));
    queries=[...new Set([...queries,...expanded])].slice(0,9);
  }
  return {queries,anchors,expanded:queries.length>1,ambiguous,source_truncated:sourceTruncated};
}

export function semanticPolicy(retrieval={},profile={}) {
  const distance=profile.distance||'Cosine',unit=profile.normalization==='l2',configured=retrieval.semantic_min_score;
  if(distance==='Cosine'||distance==='Dot'&&unit)return {distance,threshold:configured??0.55,direction:'minimum',bounded:true};
  if(distance==='Euclid'&&(unit||retrieval.semantic_max_distance!==undefined))return {distance,threshold:retrieval.semantic_max_distance??Math.sqrt(2-2*(configured??0.55)),direction:'maximum',bounded:false};
  if(distance==='Dot'&&configured!==undefined)return {distance,threshold:configured,direction:'minimum',bounded:false};
  return null; // There is no universal relevance cutoff for unnormalized dot/distance scores.
}
export function acceptsSemanticScore(score,policy) {
  if(!policy||typeof score!=='number'||!Number.isFinite(score))return false;
  if(policy.bounded&&(score< -1.000001||score>1.000001))return false;
  if(policy.direction==='maximum')return score>=0&&score<=policy.threshold;
  return score>=policy.threshold;
}

export function aliasSubjectMatches(query,name,memory){
  const rest=normalizeSearch(query).replace(termPattern(normalizeSearch(name)),' ').trim();
  return !queryGroups(rest).length||lexicalScore(rest,memory)>0;
}
