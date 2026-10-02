// Shared validation keeps identity audit and Core audit pagination/filter semantics identical.
export function auditQuery(params){
  if(Object.keys(params).some(k=>!['offset','limit','action','outcome','from','to'].includes(k)))throw new Error('Invalid audit query');
  const offset=Number(params.offset??0),limit=Number(params.limit??25);
  if(!Number.isSafeInteger(offset)||offset<0||offset>1000000||!Number.isSafeInteger(limit)||limit<1||limit>100)throw new Error('Invalid pagination');
  for(const key of ['action','outcome'])if(params[key]!==undefined&&!/^[a-zA-Z0-9_.:-]{1,100}$/.test(params[key]))throw new Error('Invalid audit filter');
  for(const key of ['from','to'])if(params[key]!==undefined){
    const value=params[key];
    if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==(value.includes('.')?value:value.replace('Z','.000Z')))throw new Error('Invalid audit date');
  }
  if(params.from&&params.to&&Date.parse(params.from)>Date.parse(params.to))throw new Error('Invalid audit range');
  return {...params,offset,limit};
}
