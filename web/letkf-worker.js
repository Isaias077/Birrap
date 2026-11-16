"use strict";

importScripts("firms-download.js?v=2");
const runtime = "https://cdn.jsdelivr.net/pyodide/v0.27.7/full/";
const report = status => self.postMessage({status});

async function bytes(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error("No se pudo cargar " + path);
  return new Uint8Array(await response.arrayBuffer());
}

async function engine(){
  report("Cargando el motor de cálculo…");
  importScripts(runtime + "pyodide.js");
  const python = await loadPyodide({indexURL: runtime, stdout: report, stderr: console.warn});
  await python.loadPackage(["numpy","scipy","matplotlib"]);
  python.unpackArchive(await bytes("motor-letkf.zip"),"zip");
  python.FS.mkdirTree("/entradas");
  python.FS.writeFile("/san-juan.json",await bytes("san-juan.json"));
  return python;
}

function processFiles(python,files,start,end,outputStart=start,outputEnd=end){
  for(const file of python.FS.readdir("/entradas").filter(f=>f.endsWith(".csv")))python.FS.unlink("/entradas/"+file);
  for(const [i,file] of files.entries())python.FS.writeFile("/entradas/"+i+".csv",file);
  for(const [k,v] of Object.entries({start_date:start,end_date:end,out_start:outputStart,out_end:outputEnd}))python.globals.set(k,v);
  return python.runPython(`
from datetime import date
import json
from pathlib import Path
from preparar import compute
try:
    result = compute(Path('/entradas'), date.fromisoformat(start_date),
                     date.fromisoformat(end_date), 12, Path('/san-juan.json'))
except ValueError as error:
    if not str(error).startswith(('Los CSV no aportan','Hay registros en San Juan')):
        raise
    result = None
if result:
    keep = [i for i,d in enumerate(result["dates"]) if out_start <= d <= out_end]
    reindex = {i:j for j,i in enumerate(keep)}
    result["dates"] = [result["dates"][i] for i in keep]
    result["rows"] = [r for r in result["rows"] if out_start <= r[1] <= out_end]
    for mode, rows in result["products"].items():
        result["products"][mode] = [[reindex[r[0]], *r[1:]] for r in rows if r[0] in reindex]
    if not result["rows"] and not any(result["products"].values()):
        result = None
json.dumps(result, separators=(',', ':'), ensure_ascii=False, allow_nan=False)
`);
}

async function downloadAndProcess({start,end,existing}){
  report("Consultando fechas disponibles en NASA FIRMS…");
  const sources=availability(await nasaCSV({type:"availability"}));
  const blocks=missingBlocks(start,end,existing);
  let python;
  for(const [index,[first,last]] of blocks.entries()){
    const ranges=[...sources].filter(([source])=>families.some(f=>source===f+"_SP"||source===f+"_NRT")).map(([,range])=>range);
    const activeFirst=Math.max(first,Math.min(...ranges.map(r=>r[0]))-1);
    const activeLast=Math.min(last,Math.max(...ranges.map(r=>r[1])));
    if(activeFirst>activeLast){
      self.postMessage({empty:[isoDay(first),isoDay(last)]});continue;
    }
    if(first<activeFirst)self.postMessage({empty:[isoDay(first),isoDay(activeFirst-1)]});
    if(last>activeLast)self.postMessage({empty:[isoDay(activeLast+1),isoDay(last)]});
    const requests=planSources(sources,activeFirst-1,activeLast+1);
    const files=[];
    for(const [i,job] of requests.entries()){
      report("Descargando FIRMS · bloque "+(index+1)+" de "+blocks.length+" · consulta "+(i+1)+" de "+requests.length);
      const csv=await nasaCSV(job);
      if(csv.trim().split(/\r?\n/).length>1)files.push(csv);
    }
    // A day with no data returned is not proof that the ground was observed.
    if(!files.length){
      self.postMessage({empty:[isoDay(activeFirst),isoDay(activeLast)]});continue;
    }
    python=python||await engine();
    report("Calculando LETKF · "+isoDay(activeFirst)+" a "+isoDay(activeLast));
    const result=processFiles(python,files,isoDay(activeFirst-1),isoDay(activeLast),isoDay(activeFirst),isoDay(activeLast));
    if(result==="null")self.postMessage({empty:[isoDay(activeFirst),isoDay(activeLast)]});
    else self.postMessage({result});
  }
  self.postMessage({done:true});
}

self.onmessage = async ({data}) => {
  try {
    await downloadAndProcess(data);
  } catch (error) {
    const message=String(error.message||error).trim().split("\n").filter(Boolean).at(-1);
    self.postMessage({error:message});
  }
};
