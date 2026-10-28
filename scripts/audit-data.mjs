// Read-only quality audit over an exported D1 observation/audit/quarantine dump.
// Usage: node --import tsx scripts/audit-data.mjs --input=/absolute/dump.json --output=/absolute/report.json
// Dump shape: Wrangler JSON blocks for SELECT observations; SELECT latest audit; SELECT quarantines.
// This validates structure, coverage and consistency. It does not claim to
// independently re-extract every historical value from every primary release.
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INDICATORS, SOURCES, PLAUSIBILITY, selectBaselineObservations, computeSourceCadence } from '../packages/shared/src/index.ts';
const arg=(name)=>process.argv.find(a=>a.startsWith(`--${name}=`))?.slice(name.length+3);
const input=arg('input');if(!input)throw new Error('Required: --input=/absolute/D1-export.json');
const bytes=await readFile(resolve(input));const blocks=JSON.parse(bytes.toString('utf8'));
const rows=Array.isArray(blocks[0]?.results)?blocks[0].results:blocks;
const attempts=blocks[1]?.results??[];const quarantines=blocks[2]?.results??[];
const now=new Date(arg('as-of')??Date.now());if(!Number.isFinite(now.getTime()))throw new Error('Invalid --as-of');
const known=rows.filter(r=>INDICATORS[r.indicator_id]);
const normalized=selectBaselineObservations(known);
const issues={nonFinite:[],outsidePlausibility:[],invalidDates:[],futurePublication:[],futureIngest:[],unexplainedFutureReference:[]};
const futureMonthlyLabels=[];
const day=(s)=>s?.slice(0,10);const ms=(s)=>typeof s==='string'?Date.parse(s):NaN;
for(const r of known){
 const meta={indicatorId:r.indicator_id,observedAt:r.observed_at,value:r.value,sourceId:r.source_id};
 if(typeof r.value!=='number'||!Number.isFinite(r.value))issues.nonFinite.push(meta);
 const bounds=PLAUSIBILITY[r.indicator_id];if(bounds&&(r.value<bounds.min||r.value>bounds.max))issues.outsidePlausibility.push({...meta,min:bounds.min,max:bounds.max});
 for(const key of ['observed_at','released_at','ingested_at'])if(r[key]!=null&&!Number.isFinite(ms(r[key])))issues.invalidDates.push({...meta,field:key,date:r[key]});
 if(ms(r.released_at)>now.getTime())issues.futurePublication.push({...meta,releasedAt:r.released_at});
 if(ms(r.ingested_at)>now.getTime()+60000)issues.futureIngest.push({...meta,ingestedAt:r.ingested_at});
 if(ms(r.observed_at)>now.getTime()){
  const observed=new Date(r.observed_at);const isMonthEnd=observed.getUTCDate()===new Date(Date.UTC(observed.getUTCFullYear(),observed.getUTCMonth()+1,0)).getUTCDate();
  const anchor=ms(r.released_at);const monthly=SOURCES[INDICATORS[r.indicator_id].sourceId]?.expectedCadence==='monthly';
  if(monthly&&isMonthEnd&&anchor<=now.getTime()&&ms(r.observed_at)-anchor<=31*86400000)futureMonthlyLabels.push({...meta,releasedAt:r.released_at});
  else issues.unexplainedFutureReference.push(meta);
 }
}
function live(r){return !r.payload_hash?.startsWith('hist:')&&!r.payload_hash?.startsWith('seed');}
const latest=[];
for(const id of Object.keys(INDICATORS)){
 const all=known.filter(r=>r.indicator_id===id);const liveRows=all.filter(live);
 const latestIngest=liveRows.map(r=>r.ingested_at??'').sort().at(-1);
 const candidates=[...liveRows.filter(r=>(r.ingested_at??'')===latestIngest),...all.filter(r=>r.payload_hash?.startsWith('hist:')).sort((a,b)=>b.observed_at.localeCompare(a.observed_at)).slice(0,1)];
 candidates.sort((a,b)=>b.observed_at.localeCompare(a.observed_at)||(Number(!live(a))-Number(!live(b)))||(b.ingested_at??'').localeCompare(a.ingested_at??''));
 if(candidates[0])latest.push(candidates[0]);
}
const dupGroups=new Map();for(const r of known){const k=`${r.indicator_id}|${day(r.observed_at)}`;dupGroups.set(k,[...(dupGroups.get(k)??[]),r]);}
const contradictions=[];const roundingOnly=[];
for(const [key,group] of dupGroups){
 const values=[...new Set(group.map(r=>r.value))];if(values.length<2)continue;
 const spread=Math.max(...values)-Math.min(...values);const id=group[0].indicator_id;
 const tolerance=id==='ftse_250'?0.51:id==='dd_failure_rate'?0.051:1e-8;
 const item={referenceDay:key,values,spread,representations:group.map(r=>({observedAt:r.observed_at,value:r.value,sourceId:r.source_id,ingestedAt:r.ingested_at,payloadClass:r.payload_hash?.split(':')[0]??null}))};
 (spread<=tolerance?roundingOnly:contradictions).push(item);
}
const coverage=Object.keys(INDICATORS).map(id=>{
 const def=INDICATORS[id];const source=SOURCES[def.sourceId];const cadence=source?.expectedCadence??'event';
 const all=known.filter(r=>r.indicator_id===id);const canonical=normalized.filter(r=>r.indicator_id===id);const dates=[...new Set(all.map(r=>day(r.observed_at)))].sort();
 const observed=latest.find(r=>r.indicator_id===id);const candidates=[];
 if(dates.length>1&&cadence==='trading-daily')for(let t=ms(dates[0]);t<=ms(dates.at(-1));t+=86400000){const d=new Date(t);const ymd=d.toISOString().slice(0,10);if(d.getUTCDay()!==0&&d.getUTCDay()!==6&&!dates.includes(ymd))candidates.push(ymd);}
 if(dates.length>1&&(cadence==='monthly'||cadence==='quarterly')){
  const step=cadence==='monthly'?1:3;const start=new Date(dates[0]);const end=day(dates.at(-1)).slice(0,7);const months=new Set(dates.map(d=>d.slice(0,7)));
  for(let m=Date.UTC(start.getUTCFullYear(),start.getUTCMonth(),1);new Date(m).toISOString().slice(0,7)<=end;){const d=new Date(m);const ym=d.toISOString().slice(0,7);if(!months.has(ym))candidates.push(ym);m=Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+step,1);}
 }
 return {indicatorId:id,label:def.label,cadence,provenance:def.provenance,rawRows:all.length,baselineReferenceDays:canonical.length,first:dates[0]??null,last:dates.at(-1)??null,missingSlotsToReview:candidates,missingSlotCaveat:cadence==='trading-daily'?'Weekday candidates only: publisher holidays, US/UK calendars and expected publication lag require source review; these are not asserted ingest failures.':'Reference-period slots between first and last stored observations; not evidence that earlier history was available.',latest:observed?{value:observed.value,observedAt:observed.observed_at,releasedAt:observed.released_at,ingestedAt:observed.ingested_at,sourceId:observed.source_id,payloadClass:observed.payload_hash?.startsWith('hist:')?'historical':observed.payload_hash?.startsWith('seed')?'seed':'live'}:null};
});
const fixturesDir=resolve(dirname(fileURLToPath(import.meta.url)),'../packages/data-sources/src/fixtures');
const fixtureIds={'brent-history.json':'brent_gbp','ftse-250-history.json':'ftse_250','consumer-confidence-history.json':'consumer_confidence','dd-failure-rate-history.json':'dd_failure_rate','rics-price-balance-history.json':'rics_price_balance','services-pmi-history.json':'services_pmi'};
const fixtureChecks=[];
for(const name of await readdir(fixturesDir)){
 const id=fixtureIds[name];if(!id)continue;const data=JSON.parse(await readFile(resolve(fixturesDir,name),'utf8'));
 const missing=[];const disagreements=[];const tolerance=id==='ftse_250'?0.51:id==='dd_failure_rate'?0.051:1e-8;
 for(const point of data.points??[]){const matches=known.filter(r=>r.indicator_id===id&&day(r.observed_at)===day(point.observed_at));if(!matches.length)missing.push(point.observed_at);else if(matches.every(r=>Math.abs(r.value-point.value)>tolerance))disagreements.push({observedAt:point.observed_at,fixture:point.value,stored:matches.map(r=>r.value)});}
 fixtureChecks.push({file:name,indicatorId:id,fixturePoints:data.points?.length??0,missingReferenceDays:missing,disagreements,tolerance});
}
const report={schemaVersion:1,generatedAt:now.toISOString(),inputSha256:createHash('sha256').update(bytes).digest('hex'),scope:{rawRows:rows.length,registeredRows:known.length,registeredIndicators:Object.keys(INDICATORS).length,unregisteredIndicatorIds:[...new Set(rows.filter(r=>!INDICATORS[r.indicator_id]).map(r=>r.indicator_id))],missingReleaseMetadata:known.filter(r=>!r.released_at).length},summary:{qualityIssueCounts:Object.fromEntries(Object.entries(issues).map(([k,v])=>[k,v.length])),futureMonthlyLabels:futureMonthlyLabels.length,duplicateReferenceDayGroups:[...dupGroups.values()].filter(g=>g.length>1).length,contradictoryReferenceDays:contradictions.length,roundingOnlyReferenceDays:roundingOnly.length,quarantines:quarantines.length},issues,futureMonthlyLabels,contradictions,roundingOnly,coverage,sourceCadence:computeSourceCadence(latest.map(r=>({sourceId:INDICATORS[r.indicator_id].sourceId,observedAt:r.observed_at,releasedAt:r.released_at})),now),latestIngestionAttempts:attempts,quarantines,fixtureChecks,limitations:['Numeric bounds, date checks and fixture parity do not prove that every historical source value was transcribed correctly.','Stored ingested_at is last write time, not an immutable first-publication or event-time record.','Historical series begin at different dates. A 2019 policy window does not imply complete observations since 2019.','Repeated same-day rows can represent timestamp migrations or revisions. Canonical baseline selection uses one reference day; contradictions remain listed for review.']};
const output=arg('output');if(output)await writeFile(resolve(output),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({generatedAt:report.generatedAt,scope:report.scope,summary:report.summary,fixtures:fixtureChecks.map(f=>({file:f.file,missing:f.missingReferenceDays.length,disagreements:f.disagreements.length})),output:output??null},null,2));
