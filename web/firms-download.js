"use strict";

const dayMS=86400000;
const dayNumber=d=>Date.parse(d+"T00:00:00Z")/dayMS;
const isoDay=d=>new Date(d*dayMS).toISOString().slice(0,10);
const families=["MODIS","VIIRS_SNPP","VIIRS_NOAA20","VIIRS_NOAA21"];

function availability(csv) {
  const [head,...rows]=csv.trim().split(/\r?\n/).map(line=>line.split(",").map(v=>v.trim().replace(/^"|"$/g,"")));
  const field=(...names)=>head.findIndex(v=>names.includes(v.toLowerCase()));
  const source=field("data_id","source","sensor");
  const min=field("min_date","start_date"),max=field("max_date","end_date");
  if([source,min,max].some(i=>i<0))throw new Error("FIRMS cambió el formato de disponibilidad.");
  const map=new Map();
  for(const r of rows){
    if(!r[source])continue;
    const first=dayNumber(r[min]),last=dayNumber(r[max]);
    if(Number.isFinite(first)&&Number.isFinite(last)&&first<=last)map.set(r[source].toUpperCase(),[first,last]);
  }
  if(!families.some(f=>map.has(f+"_SP")||map.has(f+"_NRT")))throw new Error("FIRMS no informó disponibilidad de MODIS o VIIRS.");
  return map;
}

function planSources(map,first,last) {
  const requests=[];
  for(const f of families){
    const ranges=[];
    const standard=map.get(f+"_SP"),recent=map.get(f+"_NRT");
    if(standard)ranges.push([f+"_SP",...standard]);
    if(recent){
      if(!standard)ranges.push([f+"_NRT",...recent]);
      else {
        ranges.push([f+"_NRT",recent[0],Math.min(recent[1],standard[0]-1)]);
        ranges.push([f+"_NRT",Math.max(recent[0],standard[1]+1),recent[1]]);
      }
    }
    for(const [source,min,max] of ranges){
      const end=Math.min(max,last);
      for(let start=Math.max(min,first);start<=end;start+=5){
        requests.push({type:"area",source,start:isoDay(start),days:Math.min(5,end-start+1)});
      }
    }
  }
  return requests;
}

async function nasaCSV(payload) {
  const response=await fetch("/api/firms",{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify(payload)});
  if(!response.ok){
    const body=await response.json().catch(()=>null);
    throw new Error(body?.error||"No se pudo consultar NASA FIRMS.");
  }
  return response.text();
}

function missingBlocks(start,end,existing) {
  const loaded=new Set(existing),blocks=[];
  for(let d=dayNumber(start),last=dayNumber(end);d<=last;d++){
    if(loaded.has(isoDay(d)))continue;
    const first=d;
    while(d<last&&d-first<13&&!loaded.has(isoDay(d+1)))d++;
    blocks.push([first,d]);
  }
  return blocks;
}
