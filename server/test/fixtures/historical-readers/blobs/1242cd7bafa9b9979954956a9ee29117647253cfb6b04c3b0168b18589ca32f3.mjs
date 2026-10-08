import {fail} from '../model-providers/contracts.mjs';

export function localDate(time,timezone) {
  try{return new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(time));}
  catch{fail('INVALID_TIMEZONE');}
}
export function shiftDate(date,days) {return new Date(Date.parse(date+'T12:00:00Z')+days*86400000).toISOString().slice(0,10);}
function startOfDate(date,timezone) {
  // Earliest UTC instant for the local date, including skipped/repeated midnight.
  const center=Date.parse(date+'T00:00:00Z');let lo=center-36*3600000,hi=center+36*3600000;
  while(hi-lo>1){const mid=Math.floor((lo+hi)/2);if(localDate(mid,timezone)<date)lo=mid;else hi=mid;}
  return hi;
}
export function calendarWindow(time,{timezone='UTC',period='daily'}={}) {
  if(!['daily','weekly'].includes(period) || !Number.isFinite(Number(time)))fail('INVALID_WINDOW');
  let date=localDate(time,timezone);
  if(period==='weekly'){const weekday=new Date(date+'T12:00:00Z').getUTCDay();date=shiftDate(date,-((weekday+6)%7));}
  const endDate=shiftDate(date,period==='daily'?1:7);
  return {period,timezone,local_start:date,start:new Date(startOfDate(date,timezone)).toISOString(),end:new Date(startOfDate(endDate,timezone)).toISOString(),
    dst_policy:'earliest_local_date_boundary',misfire_policy:'coalesce_dirty_closed_windows'};
}
