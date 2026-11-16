"use strict";
const $=id=>document.getElementById("h-"+id);
const label=d=>d?d.split("-").reverse().join("/"):"—";
const fmt=x=>new Intl.NumberFormat("es-AR").format(x);
const cellTypes={2:"Aumento respaldado",1:"Incierto",0:"Normal","-1":"Datos insuficientes"};
const typeColors={2:"#ed875d",1:"#e9be6f",0:"#86b49e","-1":"#687876"};
let archive,geo,dept="",source=[],start,end,month,selection,records=[],totals={},scale=1,pan=[0,0],hits=[],drag;
function count(a){return source.reduce((sum,i)=>sum+a[i],0);}
function currentRecords(){
  if(!selection)return records;
  return records.filter(([d])=>d.startsWith(selection));
}
function apply(){
  if(!archive)return;
  const a=$("start").value,b=$("end").value;
  $("other-source").hidden=true;
  if(!a||!b||a>b){
    $("status").textContent="Ingresá dos fechas válidas en orden cronológico.";
    return;
  }
  const [first,last]=dateQuery.archive;
  const inArchive=dateQuery.overlaps(a,b,dateQuery.archive);
  const inPilot=dateQuery.overlaps(a,b,dateQuery.pilot);
  start=a<first?first:a;
  end=b>last?last:b;
  if(dept!==$("region").value){scale=1;pan=[0,0];}
  dept=$("region").value;
  source={MODIS:[0,1],VIIRS:[2,3,4],Terra:[0],Aqua:[1],SNPP:[2],N20:[3],N21:[4]}[$("source").value];
  if(!inArchive)month=b<first?first.slice(0,7):last.slice(0,7);
  else if(!month||month<start.slice(0,7)||month>end.slice(0,7))month=end.slice(0,7);
  $("month").value=month; selection=null;
  records=[];totals={};
  for(const [d,cells] of Object.entries(archive.daily)){
    if(d<start||d>end)continue;
    for(const [id,a] of Object.entries(cells)){
      if(dept&&archive.cells[id][0]!==dept)continue;
      const v=count(a);
      if(v){records.push([d,id,a,v]);totals[d]=(totals[d]||0)+v;}
    }
  }
  records.sort((a,b)=>a[0].localeCompare(b[0])||a[1].localeCompare(b[1]));
  const available="Histórico: "+label(first)+" a "+label(last)+" según la fuente.";
  $("status").textContent=!inArchive
    ? "Sin datos cargados para ese intervalo. "+available+" El piloto LETKF cubre del 08/11/2026 al 15/11/2026."
    : ((a<first||b>last)?"El histórico muestra solo "+label(start)+" a "+label(end)+". ":"")+available+
      (records.length?" Cobertura sin verificar.":" Sin detecciones registradas con esta fuente y región. Cobertura sin verificar.");
  dateQuery.updateLink($("other-source"),!inArchive||inPilot,"index.html",a,b,dept);
  $("export").disabled=!records.length;
  $("month").disabled=!inArchive;
  $("month-map").disabled=!inArchive;
  $("export-anomaly").disabled=!inArchive;
  if(inArchive){
    $("month").min=start.slice(0,7);
    $("month").max=end.slice(0,7);
  }
  $("total").textContent=records.length?fmt(records.reduce((s,r)=>s+r[3],0)):"—";
  $("days").textContent=fmt(Object.keys(totals).length);
  $("cells").textContent=fmt(new Set(records.map(r=>r[1])).size);
  renderCalendar();renderPeriods();renderMap();
}
function renderCalendar(){
  const first=new Date(month+"-01T12:00:00Z");
  const max=Math.max(1,...Object.entries(totals).filter(([d])=>d.startsWith(month)).map(([,v])=>v));
  const items=[];
  for(const name of ["Lun","Mar","Mié","Jue","Vie","Sáb","Dom"]){
    const w=document.createElement("span");w.className="weekday";w.textContent=name;items.push(w);
  }
  for(let i=0;i<(first.getUTCDay()+6)%7;i++)items.push(document.createElement("span"));
  for(let d=new Date(first);d.toISOString().slice(0,7)===month;d.setUTCDate(d.getUTCDate()+1)){
    const key=d.toISOString().slice(0,10),v=totals[key]||0;
    const btn=document.createElement("button");btn.className="day"+(selection===key?" selected":"");
    btn.disabled=key<start||key>end;btn.setAttribute("aria-label",label(key)+" · "+(v?fmt(v)+" detecciones":"sin registros"));
    const day=document.createElement("b"),metric=document.createElement("span");day.textContent=d.getUTCDate();metric.textContent=v?fmt(v):"—";
    if(v)btn.style.background=color(v,max);
    btn.append(day,metric);btn.onclick=()=>{selection=key; $("layer").value="count";renderCalendar();renderMap();};items.push(btn);
  }
  $("calendar").replaceChildren(...items);
}
function renderPeriods(){
  const periods=new Map(),years=new Map();
  for(const [d,v] of Object.entries(totals)){
    const m=d.slice(0,7),y=d.slice(0,4);
    periods.set(m,(periods.get(m)||0)+v);years.set(y,(years.get(y)||0)+v);
  }
  $("peak").textContent=[...periods].sort((a,b)=>b[1]-a[1])[0]?.[0]||"—";
  const table=document.createElement("table");
  const head=table.createTHead().insertRow();
  for(const name of ["Período UTC","Detecciones de "+$("source").value,"Navegar"]){const th=document.createElement("th");th.textContent=name;head.append(th);}
  const body=table.createTBody();
  for(const [year,total] of [...years].sort((a,b)=>b[0].localeCompare(a[0]))){
    const row=body.insertRow();row.insertCell().textContent=year;row.insertCell().textContent=fmt(total);row.insertCell().textContent="Año";
    for(const [key,v] of [...periods].filter(([m])=>m.startsWith(year)).sort((a,b)=>a[0].localeCompare(b[0]))){
      const r=body.insertRow();r.insertCell().textContent=key;r.insertCell().textContent=fmt(v);
      const b=document.createElement("button");b.textContent="Ver "+key;
      b.onclick=()=>{month=key;$("month").value=month;selection=key;renderCalendar();renderMap();$("calendar").scrollIntoView({block:"center"});};
      r.insertCell().append(b);
    }
  }
  $("periods").replaceChildren(table);
}
function color(v,max){
  const t=Math.log1p(v)/Math.log1p(Math.max(1,max));
  return "rgb("+Math.round(100+140*t)+","+Math.round(57+121*t)+","+Math.round(29+65*t)+")";
}
function renderMap(){
  if(!archive)return;
  const canvas=$("map"),{width:w,height:h}=canvas.getBoundingClientRect(),px=devicePixelRatio||1;
  canvas.width=w*px;canvas.height=h*px;
  const ctx=canvas.getContext("2d");ctx.scale(px,px);
  hits=[];
  const features=dept?geo.features.filter(f=>f.properties.nombre===dept):geo.features;
  const geometry=f=>f.geometry.type==="Polygon"?[f.geometry.coordinates]:f.geometry.coordinates;
  const coords=features.flatMap(f=>geometry(f).flat(2));
  const xs=coords.map(p=>p[0]),ys=coords.map(p=>p[1]),minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);
  const ratio=Math.min((w-45)/((maxX-minX)*.86),(h-42)/(maxY-minY))*scale;
  const xy=([x,y])=>[w/2+pan[0]+(x-(minX+maxX)/2)*ratio*.86,h/2+pan[1]-(y-(minY+maxY)/2)*ratio];
  const ring=points=>{points.forEach((p,i)=>{if(i)ctx.lineTo(...xy(p));else ctx.moveTo(...xy(p));});ctx.closePath();};
  ctx.fillStyle="#101b1c";ctx.fillRect(0,0,w,h);
  for(const f of geo.features){
    ctx.beginPath();for(const p of geometry(f))for(const r of p)ring(r);
    ctx.fillStyle="#253434";ctx.fill("evenodd");ctx.strokeStyle="#4b605b";ctx.stroke();
  }
  const values=new Map();
  for(const [,id,,v] of currentRecords())values.set(id,(values.get(id)||0)+v);
  const maximum=Math.max(1,...values.values());
  const anomaly=$("layer").value==="anomaly";
  const states=start<=end ? (archive.months[month]||{}) : {};
  $("map-caption").textContent=anomaly?month+" · Fuente V12: "+(archive.source_by_month[month]||"sin referencia"):(selection||start+" a "+end)+" · "+$("source").value;
  $("legend").textContent=anomaly?"Coral: aumento respaldado · Ámbar: incierto · Verde: normal · Gris: datos insuficientes":"Detecciones por celda · claro = más registros";
  for(const [id,[dep,points,quality]] of Object.entries(archive.cells)){
    if(dept&&dept!==dep)continue;
    const state=states[id],v=values.get(id);
    ctx.beginPath();ring(points);
    ctx.fillStyle=anomaly?(state?typeColors[state[0]]:"#2e3938"):(v?color(v,maximum):"#263232");
    ctx.globalAlpha=.86;ctx.fill();ctx.globalAlpha=1;ctx.strokeStyle="#73817a";ctx.stroke();
    const projected=points.map(xy);
    hits.push([Math.min(...projected.map(p=>p[0])),Math.max(...projected.map(p=>p[0])),Math.min(...projected.map(p=>p[1])),Math.max(...projected.map(p=>p[1])),
      "Celda "+id+" · "+dep+" · "+(anomaly?(state?cellTypes[state[0]]+" · "+fmt(state[1])+" detecciones de la fuente V12 · clase "+quality:"sin clasificación registrada"):(v?fmt(v)+" detecciones":"sin registros para esta consulta"))]);
  }
}
const map=$("map");
map.onpointerdown=e=>{map.setPointerCapture(e.pointerId);drag=[e.offsetX,e.offsetY,...pan];};
map.onpointermove=e=>{if(!drag)return;pan=[drag[2]+e.offsetX-drag[0],drag[3]+e.offsetY-drag[1]];renderMap();};
map.onpointerup=e=>{
  if(drag&&Math.hypot(e.offsetX-drag[0],e.offsetY-drag[1])<5){
    const item=hits.find(([l,r,t,b])=>e.offsetX>=l&&e.offsetX<=r&&e.offsetY>=t&&e.offsetY<=b);
    $("inspect").textContent=item?.[4]||"Seleccioná una celda histórica.";
  }
  drag=null;
};
map.onpointercancel=()=>{drag=null;};
function zoom(factor){scale=Math.min(12,Math.max(.6,scale*factor));renderMap();}
$("plus").onclick=()=>zoom(1.5);$("minus").onclick=()=>zoom(1/1.5);
$("home").onclick=()=>{scale=1;pan=[0,0];renderMap();};
$("filters").onsubmit=e=>{e.preventDefault();apply();};
$("filters").onchange=apply;
$("month").onchange=()=>{
  const input=$("month");
  if(!input.value||!input.validity.valid){input.value=month;return;}
  month=input.value;selection=month;renderCalendar();renderMap();
};
$("month-map").onclick=()=>{selection=month;renderCalendar();renderMap();};
$("all").onclick=()=>{selection=null;$("layer").value="count";renderCalendar();renderMap();};
$("layer").onchange=renderMap;
function download(url,name){const a=document.createElement("a");a.href=url;a.download=name;a.click();}
$("png").onclick=()=>download(map.toDataURL(),"mapa-historico-san-juan.png");
$("export").onclick=()=>{
  if(!archive)return;
  const rows=records.map(([d,id,a,v])=>[d,id,archive.cells[id][0],...a,$("source").value,v]);
  const q=v=>'"'+String(v).replaceAll('"','""')+'"';
  const blob=new Blob(["\ufeff",...[["fecha_utc","celda_50km","departamento_centro","terra","aqua","snpp","noaa20","noaa21","fuente_consulta","detecciones_consulta"],...rows].map(r=>r.map(q).join(",")+"\r\n")],{type:"text/csv;charset=utf-8"});
  const url=URL.createObjectURL(blob);download(url,"historico-firms-san-juan.csv");setTimeout(()=>URL.revokeObjectURL(url),2000);
};
$("export-anomaly").onclick=()=>{
  if(!archive)return;
  const items=Object.entries(archive.months[month]||{}).filter(([id])=>!dept||archive.cells[id][0]===dept);
  const rows=items.map(([id,r])=>[month,id,archive.cells[id][0],archive.source_by_month[month],cellTypes[r[0]],r[1],archive.cells[id][2]]);
  const q=v=>'"'+String(v??"").replaceAll('"','""')+'"';
  const header=["mes","celda_50km","departamento_centro","fuente_v12","estado","detecciones_fuente","clase"];
  const blob=new Blob(["\ufeff",...[header,...rows].map(r=>r.map(q).join(",")+"\r\n")],{type:"text/csv;charset=utf-8"});
  const url=URL.createObjectURL(blob);download(url,"anomalias-v12-"+month+".csv");setTimeout(()=>URL.revokeObjectURL(url),2000);
};
new ResizeObserver(()=>renderMap()).observe(map);
Promise.all(["historico.json","san-juan.json"].map(async file=>{const r=await fetch(file);if(!r.ok)throw Error(file);return r.json();})).then(([a,g])=>{
  archive=a;geo=g;
  for(const dep of g.features.map(f=>f.properties.nombre).sort((a,b)=>a.localeCompare(b,"es")))$("region").add(new Option(dep,dep));
  dateQuery.restoreRegion($("region"));
  $("start").value=dateQuery.readDate("desde",dateQuery.archive[0]);
  $("end").value=dateQuery.readDate("hasta",dateQuery.archive[1]);
  apply();
}).catch(()=>{$("status").textContent="No se pudo cargar el archivo de datos históricos.";});
