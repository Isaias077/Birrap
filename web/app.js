"use strict";
const $ = id => document.getElementById(id);
const n = new Intl.NumberFormat("es-AR");
const num = x => n.format(x);
const fmt = x => new Intl.NumberFormat("es-AR",{maximumFractionDigits:2}).format(x);
const dateLabel = d => d ? d.split("-").reverse().join("/") : "—";
const modes = ["ambos","modis","viirs"];
const names = {ambos:"Combinado",modis:"Solo MODIS",viirs:"Solo VIIRS"};
const colors = {ambos:"#e9be6f",modis:"#a7bcf6",viirs:"#a5d8ae"};
const reference = 4;
let data,geo,worker,lastComputed,rows=[],selected=null,start="",end="",region="",threshold=1,month;
let daily={}, cells={}, combined=[], known=new Set(), viewport={scale:1,x:0,y:0}, drag, targets=[];
let mapWidth=0,mapHeight=0,lastProj=null;
let area=null,drawMode=false,boxDrag=null,fireScale="day",fcMonth=null,fcYear=null,fireRange=null;
const map=$("map"), chart=$("chart");
const checkedWithoutData=new Set();
const sorted=(a,b)=>a.localeCompare(b,"es");
const dayISO=d=>d.toISOString().slice(0,10);
const dayObject=d=>new Date(d+"T12:00:00Z");
function inArea(lat,lon){
  if(!area)return true;
  if(area.type==="box")return lat>=area.minLat&&lat<=area.maxLat&&lon>=area.minLon&&lon<=area.maxLon;
  const [, ,kx,ky]=data.grid;
  return Math.hypot((lon-area.lon)*kx,(lat-area.lat)*ky)<=area.rKm;
}
function cellInArea(gx,gy){
  if(!area)return true;
  const [west,south,kx,ky,cell]=data.grid;
  return inArea(south+(gy+.5)*cell/ky,west+(gx+.5)*cell/kx);
}
function dateMatch(d){
  if(selected)return d===selected;
  if(fireRange)return d.startsWith(fireRange);
  return true;
}
function setDrawMode(on){
  drawMode=on;
  map.classList.toggle("drawing",on);
  $("map-hint").hidden=!on;
  for(const id of ["draw-btn","draw-map"])$(id).setAttribute("aria-pressed",String(on));
  $("draw-btn").textContent=on?"Cancelá con Esc":"Marcar zona en el mapa";
}
function focusBounds(minLon,maxLon,minLat,maxLat){
  if(!geo)return;
  const visible=region?geo.features.filter(f=>f.properties.nombre===region):geo.features;
  const coords=visible.flatMap(f=>polygons(f).flat(2));
  const xmin=Math.min(...coords.map(p=>p[0])),xmax=Math.max(...coords.map(p=>p[0]));
  const ymin=Math.min(...coords.map(p=>p[1])),ymax=Math.max(...coords.map(p=>p[1]));
  const lonCorr=.86,w=mapWidth||map.clientWidth||700,h=mapHeight||map.clientHeight||445;
  const base=Math.min((w-64)/((xmax-xmin)*lonCorr),(h-54)/(ymax-ymin));
  const spanLon=Math.max(0.08,(maxLon-minLon)*1.6),spanLat=Math.max(0.08,(maxLat-minLat)*1.6);
  const scale=Math.min(36,Math.max(1,Math.min((w-80)/(spanLon*base*lonCorr),(h-80)/(spanLat*base))));
  const cLon=(minLon+maxLon)/2,cLat=(minLat+maxLat)/2;
  viewport={scale,x:-(cLon-(xmin+xmax)/2)*base*lonCorr*scale,y:-((ymin+ymax)/2-cLat)*base*scale};
}
function updateAreaStatus(){
  const el=$("area-status");
  $("clear-area").disabled=!area;
  el.classList.remove("warn");
  if(!area){
    el.textContent="Ingresá coordenadas o marcá una zona en el mapa para filtrar los resultados.";
    return;
  }
  const desc=area.type==="circle"
    ? "Punto ("+fmt(area.lat)+"°, "+fmt(area.lon)+"°) · radio "+fmt(area.rKm)+" km"
    : "Zona ["+fmt(area.minLat)+"° a "+fmt(area.maxLat)+"° lat, "+fmt(area.minLon)+"° a "+fmt(area.maxLon)+"° lon]";
  const [west,south,kx,ky,cell]=data.grid;
  const maxLon=west+900*cell/kx,maxLat=south+900*cell/ky;
  const out=area.type==="circle"
    ? (area.lat<south||area.lat>maxLat||area.lon<west||area.lon>maxLon)
    : (area.maxLat<south||area.minLat>maxLat||area.maxLon<west||area.minLon>maxLon);
  if(out)el.classList.add("warn");
  el.textContent=desc+" · "+num(rows.length)+" detecciones y "+num(cells.ambos?.ref.length||0)+" celdas activas × día en el intervalo."+(out?" (Fuera o al borde de la grilla de San Juan)":"");
}
function showTable(target, headers, values){
  const table=document.createElement("table"), head=table.createTHead().insertRow();
  for(const h of headers){const th=document.createElement("th");th.scope="col";th.textContent=h;head.append(th);}
  const body=table.createTBody();
  for(const row of values){const tr=body.insertRow(); for(const value of row) tr.insertCell().textContent=value;}
  $(target).replaceChildren(table);
}
function canvasContext(canvas){
  const rect=canvas.getBoundingClientRect(),ratio=devicePixelRatio||1;
  const w=Math.round(rect.width),h=Math.round(rect.height);
  canvas.width=Math.max(1,w*ratio);canvas.height=Math.max(1,h*ratio);
  const ctx=canvas.getContext("2d");ctx.setTransform(ratio,0,0,ratio,0,0);
  return {ctx,w,h};
}
function aggregate(items,size){
  const results=new Map();
  for(const [d,x,y,e,dep] of items){
    const a=Math.floor(x/size)*size,b=Math.floor(y/size)*size,key=d+"|"+a+"|"+b;
    const cell=results.get(key);
    if(cell)cell[3]+=e;
    else results.set(key,[d,a,b,e,dep]);
  }
  return [...results.values()];
}
function apply(){
  if(!data)return;
  const a=$("desde").value,b=$("hasta").value;
  $("other-source").hidden=true;
  if(!a||!b||a>b){
    $("status").textContent="Ingresá dos fechas válidas en orden cronológico.";
    return;
  }
  const inArchive=dateQuery.overlaps(a,b,dateQuery.archive);
  known=new Set(data.dates.filter(d=>d>=a&&d<=b));
  const hasData=known.size>0;
  const previousRegion=region;
  start=a;end=b;region=$("region").value;threshold=Number($("threshold").value);
  if(selected && (selected<start||selected>end))selected=null;
  if(fireRange && (fireRange>end.slice(0,fireRange.length)||fireRange<start.slice(0,fireRange.length)))fireRange=null;
  month=dayObject(selected||[...known][0]||start);
  if(!fcMonth||fcMonth< dayObject(start.slice(0,7)+"-01")||fcMonth>dayObject(end.slice(0,7)+"-01"))fcMonth=new Date(month);
  if(!fcYear)fcYear=month.getUTCFullYear();
  rows=data.rows.filter(r=>r[1]>=start&&r[1]<=end&&(!region||r[10]===region)&&inArea(r[2],r[3]));
  cells={};daily={};
  for(const mode of modes){
    const fine=data.products[mode].filter(r=>known.has(data.dates[r[0]])&&(!region||r[4]===region)&&cellInArea(r[1],r[2]));
    cells[mode]={fine,ref:aggregate(fine,reference).filter(r=>r[3]>=threshold)};
    daily[mode]=new Map();
    for(const r of fine){
      const d=data.dates[r[0]], state=daily[mode].get(d)||{energy:0,active:0};
      state.energy+=r[3]; daily[mode].set(d,state);
    }
    for(const r of cells[mode].ref)daily[mode].get(data.dates[r[0]]).active++;
  }
  combined=[...daily.ambos.entries()].sort(([x],[y])=>sorted(x,y));
  const days=combined.filter(([,x])=>x.active>0);
  const total=days.reduce((v,[,x])=>v+x.active,0);
  const energy=combined.reduce((v,[,x])=>v+x.energy,0);
  const peak=days.reduce((best,d)=>!best||d[1].active>best[1].active?d:best,null);
  $("stat-active").textContent=total?num(total):"—";
  $("stat-energy").textContent=energy?fmt(energy)+" MWh":"—";
  $("stat-raw").textContent=hasData?num(rows.length):"—";
  $("stat-peak").textContent=dateLabel(peak?.[0]);
  $("stat-peaktxt").textContent=peak?num(peak[1].active)+" celdas":"Por celdas activas";
  const daysRequested=Math.round((dayObject(end)-dayObject(start))/86400000)+1;
  $("status").textContent=hasData
    ? "LETKF · "+num(known.size)+" de "+num(daysRequested)+" días con resultados cargados en el intervalo. Cobertura satelital sin verificar."
    : "Sin resultados LETKF para este intervalo. Pulsá Analizar para solicitar los datos a NASA FIRMS.";
  dateQuery.updateLink($("other-source"),inArchive,"historico.html",a,b,region);
  for(const id of ["export-summary","export-cells","export-raw","export-map","export-chart"]) $(id).disabled=!hasData;
  if(previousRegion!==region)viewport={scale:1,x:0,y:0};
  updateAreaStatus();
  renderCalendar();renderFireCalendar();renderMap();renderChart();renderTables();
}
function renderCalendar(){
  $("month-name").textContent=new Intl.DateTimeFormat("es-AR",{month:"long",year:"numeric",timeZone:"UTC"}).format(month);
  const first=new Date(month);first.setUTCDate(1);
  const max=Math.max(1,...combined.map(([,v])=>v.active));
  const items=[];
  for(const name of ["Lun","Mar","Mié","Jue","Vie","Sáb","Dom"]){
    const el=document.createElement("span");el.className="weekday";el.textContent=name;items.push(el);
  }
  for(let i=0;i<(first.getUTCDay()+6)%7;i++)items.push(document.createElement("span"));
  for(let d=new Date(first);d.getUTCMonth()===first.getUTCMonth();d.setUTCDate(d.getUTCDate()+1)){
    const key=dayISO(d),value=daily.ambos.get(key)?.active||0;
    const btn=document.createElement("button");btn.className="day"+(key===selected?" selected":"");
    btn.disabled=key<start||key>end||!known.has(key);
    btn.setAttribute("aria-pressed",String(key===selected));
    btn.setAttribute("aria-label",dateLabel(key)+" · "+(value?num(value)+" celdas activas":known.has(key)?"sin celdas activas estimadas, cobertura sin verificar":"fuera de los datos cargados"));
    const b=document.createElement("b"), s=document.createElement("span");b.textContent=d.getUTCDate();s.textContent=value?num(value):"—";btn.append(b,s);
    if(value)btn.style.background=heat(value,max,0.85);
    btn.onclick=()=>{fireRange=null;selected=key===selected?null:key;renderCalendar();renderFireCalendar();renderMap();};
    items.push(btn);
  }
  $("calendar").replaceChildren(...items);
}
function renderFireCalendar(){
  if(!data||!start)return;
  const grid=$("fire-calendar");
  grid.className="fire-grid "+fireScale;
  const byDay=new Map(),byMonth=new Map(),byYear=new Map();
  const cDay=new Map(),cMonth=new Map(),cYear=new Map();
  for(const r of rows){
    const d=r[1],m=d.slice(0,7),y=d.slice(0,4);
    byDay.set(d,(byDay.get(d)||0)+1);
    byMonth.set(m,(byMonth.get(m)||0)+1);
    byYear.set(y,(byYear.get(y)||0)+1);
  }
  for(const [d,v] of daily.ambos.entries()){
    if(!v.active)continue;
    const m=d.slice(0,7),y=d.slice(0,4);
    cDay.set(d,(cDay.get(d)||0)+v.active);
    cMonth.set(m,(cMonth.get(m)||0)+v.active);
    cYear.set(y,(cYear.get(y)||0)+v.active);
  }
  const items=[];
  if(fireScale==="day"){
    $("fc-title").textContent=new Intl.DateTimeFormat("es-AR",{month:"long",year:"numeric",timeZone:"UTC"}).format(fcMonth);
    $("fc-prev").disabled=false;$("fc-next").disabled=false;
    const first=new Date(fcMonth);first.setUTCDate(1);
    const max=Math.max(1,...byDay.values(),...cDay.values());
    for(const name of ["Lun","Mar","Mié","Jue","Vie","Sáb","Dom"]){
      const el=document.createElement("span");el.className="weekday";el.textContent=name;items.push(el);
    }
    for(let i=0;i<(first.getUTCDay()+6)%7;i++)items.push(document.createElement("span"));
    let mFocos=0,mCeldas=0;
    for(let d=new Date(first);d.getUTCMonth()===first.getUTCMonth();d.setUTCDate(d.getUTCDate()+1)){
      const key=dayISO(d),inRange=key>=start&&key<=end&&known.has(key);
      const focos=byDay.get(key)||0,celdas=cDay.get(key)||0;
      if(inRange){mFocos+=focos;mCeldas+=celdas;}
      const btn=document.createElement("button");
      btn.type="button";
      btn.className="fcell"+(selected===key?" selected":"")+(!inRange?" out":"");
      btn.disabled=!inRange;
      const b=document.createElement("b"),st=document.createElement("strong"),sm=document.createElement("small");
      b.textContent=d.getUTCDate();
      st.textContent=inRange?num(focos):"—";
      sm.textContent=inRange?(focos===1?"1 foco":num(focos)+" focos")+(celdas?" · "+num(celdas)+" cel.":""):"sin datos";
      btn.append(b,st,sm);
      if(focos||celdas)btn.style.background=heat(focos||celdas,max,0.85);
      btn.onclick=()=>{
        fireRange=null;selected=selected===key?null:key;
        month=dayObject(key);
        renderCalendar();renderFireCalendar();renderMap();
      };
      items.push(btn);
    }
    $("fc-summary").textContent="Mes visible: "+num(mFocos)+" focos detectados · "+num(mCeldas)+" celdas activas × día. Hacé clic en un día para filtrarlo en el mapa.";
  }else if(fireScale==="month"){
    $("fc-title").textContent="Año "+fcYear;
    $("fc-prev").disabled=false;$("fc-next").disabled=false;
    const max=Math.max(1,...byMonth.values(),...cMonth.values());
    const mNames=["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];
    let yFocos=0,yCeldas=0;
    for(let m=0;m<12;m++){
      const key=fcYear+"-"+String(m+1).padStart(2,"0");
      const hasKnown=[...known].some(d=>d.startsWith(key));
      const focos=byMonth.get(key)||0,celdas=cMonth.get(key)||0;
      yFocos+=focos;yCeldas+=celdas;
      const btn=document.createElement("button");
      btn.type="button";
      btn.className="fcell"+(fireRange===key?" selected":"")+(!hasKnown?" out":"");
      btn.disabled=!hasKnown;
      const b=document.createElement("b"),st=document.createElement("strong"),sm=document.createElement("small");
      b.textContent=mNames[m];
      st.textContent=hasKnown?num(focos):"—";
      sm.textContent=hasKnown?num(focos)+" focos · "+num(celdas)+" cel.":"sin datos";
      btn.append(b,st,sm);
      if(focos||celdas)btn.style.background=heat(focos||celdas,max,0.85);
      btn.onclick=()=>{
        selected=null;fireRange=fireRange===key?null:key;
        fcMonth=dayObject(key+"-01");month=new Date(fcMonth);
        renderCalendar();renderFireCalendar();renderMap();
      };
      items.push(btn);
    }
    $("fc-summary").textContent="Año "+fcYear+": "+num(yFocos)+" focos detectados · "+num(yCeldas)+" celdas activas × día. Hacé clic en un mes para filtrarlo en el mapa.";
  }else{
    const years=[...new Set([start.slice(0,4),end.slice(0,4),...[...known].map(d=>d.slice(0,4))])].sort();
    const y0=Math.min(...years.map(Number))-1,y1=Math.max(...years.map(Number))+1;
    $("fc-title").textContent=y0+" – "+y1;
    $("fc-prev").disabled=true;$("fc-next").disabled=true;
    const max=Math.max(1,...byYear.values(),...cYear.values());
    for(let y=y0;y<=y1;y++){
      const key=String(y),hasKnown=[...known].some(d=>d.startsWith(key));
      const focos=byYear.get(key)||0,celdas=cYear.get(key)||0;
      const btn=document.createElement("button");
      btn.type="button";
      btn.className="fcell"+(fireRange===key?" selected":"")+(!hasKnown?" out":"");
      btn.disabled=!hasKnown;
      const b=document.createElement("b"),st=document.createElement("strong"),sm=document.createElement("small");
      b.textContent=key;
      st.textContent=hasKnown?num(focos):"—";
      sm.textContent=hasKnown?num(focos)+" focos · "+num(celdas)+" cel.":"sin datos";
      btn.append(b,st,sm);
      if(focos||celdas)btn.style.background=heat(focos||celdas,max,0.85);
      btn.onclick=()=>{
        selected=null;fireRange=fireRange===key?null:key;
        fcYear=y;
        renderCalendar();renderFireCalendar();renderMap();
      };
      items.push(btn);
    }
    $("fc-summary").textContent="Total en el intervalo: "+num(rows.length)+" focos detectados. Hacé clic en un año para filtrarlo en el mapa.";
  }
  grid.replaceChildren(...items);
}
function heat(v,max,alpha=1){
  const t=Math.log1p(v)/Math.log1p(Math.max(max,1));
  return "rgba("+Math.round(100+145*t)+","+Math.round(62+105*t)+","+Math.round(30+47*t)+","+alpha+")";
}
function polygons(f){return f.geometry.type==="Polygon"?[f.geometry.coordinates]:f.geometry.coordinates;}
function renderMap(){
  if(!geo || !start)return;
  const {ctx,w,h}=canvasContext(map);mapWidth=w;mapHeight=h;
  targets=[];
  const visible=region?geo.features.filter(f=>f.properties.nombre===region):geo.features;
  const coords=visible.flatMap(f=>polygons(f).flat(2));
  const xmin=Math.min(...coords.map(p=>p[0])),xmax=Math.max(...coords.map(p=>p[0]));
  const ymin=Math.min(...coords.map(p=>p[1])),ymax=Math.max(...coords.map(p=>p[1]));
  const lonCorr=.86;
  const base=Math.min((w-64)/((xmax-xmin)*lonCorr),(h-54)/(ymax-ymin));
  const toXY=(lon,lat)=>[w/2+viewport.x+(lon-(xmin+xmax)/2)*base*lonCorr*viewport.scale,h/2+viewport.y+((ymin+ymax)/2-lat)*base*viewport.scale];
  const toLonLat=(x,y)=>[(xmin+xmax)/2+(x-w/2-viewport.x)/(base*lonCorr*viewport.scale),(ymin+ymax)/2-(y-h/2-viewport.y)/(base*viewport.scale)];
  lastProj={toXY,toLonLat,base,lonCorr};
  ctx.fillStyle="#101b1c";ctx.fillRect(0,0,w,h);
  ctx.strokeStyle="#263636";ctx.lineWidth=1;
  for(let x=0;x<w;x+=31){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,h);ctx.stroke();}
  for(let y=0;y<h;y+=31){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();}
  const border=f=>{
    ctx.beginPath();
    for(const polygon of polygons(f))for(const ring of polygon){
      ring.forEach(([lon,lat],i)=>{const p=toXY(lon,lat);if(i)ctx.lineTo(...p);else ctx.moveTo(...p);});
      ctx.closePath();
    }
  };
  for(const f of geo.features){
    border(f);ctx.fillStyle=!region||f.properties.nombre===region?"#243334":"#192727";
    ctx.fill("evenodd");ctx.strokeStyle="#4b605b";ctx.stroke();
  }
  const [west,south,kx,ky,cell]=data.grid;
  const width375=base*lonCorr*viewport.scale*cell/kx;
  const setting=$("layer").value;
  const observed=setting.startsWith("obs")||(setting==="auto"&&width375>=9);
  const approx=setting==="auto"&&observed;
  const mode=modes.includes(setting)?setting:"ambos";
  const dateOk=dateMatch;
  const resolution=width375<.7?32:width375<2?16:width375<5?4:1;
  if(observed){
    const focus=rows.filter(r=>dateOk(r[1])&&(setting==="obs-modis"?r[5]==="MODIS":setting==="obs-viirs"?r[5]==="VIIRS":true));
    focus.sort((a,b)=>b[7]*b[8]-a[7]*a[8]);
    for(const r of focus){
      const [x,y]=toXY(r[3],r[2]),rw=Math.max(3,r[7]*width375/cell),rh=Math.max(3,r[8]*width375/cell);
      if(x+rw<0||x-rw>w||y+rh<0||y-rh>h)continue;
      ctx.fillStyle=r[5]==="VIIRS"?"#f5ba63aa":"#a7bcf685";ctx.strokeStyle=r[5]==="VIIRS"?"#f7c789":"#c5d7fb";
      ctx.fillRect(x-rw/2,y-rh/2,rw,rh);ctx.strokeRect(x-rw/2,y-rh/2,rw,rh);
      targets.push([x-rw/2,y-rh/2,rw,rh,r[4]+" · "+r[0].replace("T"," ")+" UTC · FRP "+(r[6]===null?"sin dato":fmt(r[6])+" MW")+" · "+fmt(r[7])+" × "+fmt(r[8])+" km · "+r[10]]);
    }
    $("legend").textContent=(approx?"Automático · ":"")+"Detecciones · VIIRS naranja / MODIS azul · huellas aproximadas";
  }else{
    const items=cells[mode]||{ref:[],fine:[]};
    const refs=items.ref.filter(r=>dateOk(data.dates[r[0]]));
    const active=new Set(refs.map(r=>r[0]+"|"+r[1]+"|"+r[2]));
    const visibleCells=new Map();
    const detail=resolution===1;
    const source=detail?items.fine.filter(r=>dateOk(data.dates[r[0]])&&active.has(r[0]+"|"+Math.floor(r[1]/4)*4+"|"+Math.floor(r[2]/4)*4)):refs;
    for(const r of source){
      const x=Math.floor(r[1]/resolution)*resolution,y=Math.floor(r[2]/resolution)*resolution,key=x+"|"+y;
      const prev=visibleCells.get(key)||[x,y,0,0];
      prev[2]+=detail?r[3]:1;prev[3]+=r[3];visibleCells.set(key,prev);
    }
    let max=1;for(const r of visibleCells.values())max=Math.max(max,r[2]);
    for(const [gx,gy,v,e] of visibleCells.values()){
      const [x,y]=toXY(west+gx*cell/kx,south+(gy+resolution)*cell/ky);
      const [right,bottom]=toXY(west+(gx+resolution)*cell/kx,south+gy*cell/ky);
      if(right<0||x>w||bottom<0||y>h)continue;
      const dw=Math.max(right-x,2),dh=Math.max(bottom-y,2);
      ctx.fillStyle=heat(v,max,.86);ctx.fillRect(x,y,dw,dh);
      ctx.strokeStyle="#f6c57d70";ctx.lineWidth=.6;ctx.strokeRect(x,y,dw,dh);
      targets.push([x,y,dw,dh,names[mode]+" · "+(detail?"FRP integrado estimado "+fmt(e)+" MWh":num(v)+" celdas activas × día · "+fmt(e)+" MWh estimados")+" · "+fmt(resolution*cell)+" km"]);
    }
    $("legend").textContent=(setting==="auto"?"Automático · ":"")+"LETKF "+names[mode].toLowerCase()+" · "+fmt(resolution*cell)+" km · "+(detail?"energía estimada":"celdas activas × día");
  }
  ctx.font="11px system-ui";ctx.textAlign="center";
  const placed=[];
  for(const f of visible){
    const c=f.properties.centroide;if(!c)continue;
    const [x,y]=toXY(c.lon,c.lat);
    const half=ctx.measureText(f.properties.nombre).width/2+3;
    if(x<half||x>w-half-42||y<12||y>h-12||placed.some(([px,py,hw])=>Math.abs(y-py)<14&&Math.abs(x-px)<half+hw))continue;
    placed.push([x,y,half]);
    ctx.strokeStyle="#162122";ctx.lineWidth=3;ctx.strokeText(f.properties.nombre,x,y);
    ctx.fillStyle="#a3b3a7";ctx.fillText(f.properties.nombre,x,y);
  }
  if(area){
    const [ , ,kx,ky]=data.grid;
    ctx.save();
    ctx.strokeStyle="#d3e690";ctx.fillStyle="rgba(211,230,144,0.12)";ctx.lineWidth=1.8;ctx.setLineDash([5,4]);
    if(area.type==="box"){
      const [x1,y1]=toXY(area.minLon,area.maxLat),[x2,y2]=toXY(area.maxLon,area.minLat);
      ctx.fillRect(x1,y1,x2-x1,y2-y1);ctx.strokeRect(x1,y1,x2-x1,y2-y1);
    }else{
      const [cx,cy]=toXY(area.lon,area.lat);
      const rx=area.rKm/kx*base*lonCorr*viewport.scale,ry=area.rKm/ky*base*viewport.scale;
      ctx.beginPath();ctx.ellipse(cx,cy,Math.max(4,rx),Math.max(4,ry),0,0,Math.PI*2);ctx.fill();ctx.stroke();
      ctx.setLineDash([]);ctx.fillStyle="#d3e690";
      ctx.beginPath();ctx.arc(cx,cy,4,0,Math.PI*2);ctx.fill();
    }
    ctx.restore();
  }
  if(boxDrag){
    ctx.save();
    const x=Math.min(boxDrag.x0,boxDrag.x1),y=Math.min(boxDrag.y0,boxDrag.y1);
    const bw=Math.abs(boxDrag.x1-boxDrag.x0),bh=Math.abs(boxDrag.y1-boxDrag.y0);
    ctx.fillStyle="rgba(211,230,144,0.18)";ctx.strokeStyle="#d3e690";ctx.lineWidth=1.5;ctx.setLineDash([4,3]);
    ctx.fillRect(x,y,bw,bh);ctx.strokeRect(x,y,bw,bh);
    ctx.restore();
  }
  $("map-date").textContent=selected?dateLabel(selected):fireRange?"Filtro: "+fireRange:dateLabel(start)+" al "+dateLabel(end);
}
function renderChart(){
  if(!start)return;
  const {ctx,w,h}=canvasContext(chart);
  ctx.fillStyle="#172223";ctx.fillRect(0,0,w,h);
  ctx.font="12px system-ui";ctx.textAlign="left";
  for(let i=0;i<modes.length;i++){
    const m=modes[i],x=42+i*102;
    ctx.fillStyle=colors[m];ctx.fillRect(x,13,9,9);ctx.fillText(names[m],x+13,22);
  }
  const days=[...known];
  if(!days.length){ctx.fillStyle="#a1b2ab";ctx.fillText("Sin fechas procesadas en la selección.",42,65);return;}
  const max=Math.max(4,...modes.flatMap(m=>days.map(d=>daily[m].get(d)?.active||0)));
  const top=37,bottom=h-30,left=43,right=w-20,range=bottom-top,step=(right-left)/days.length;
  ctx.font="10px system-ui";
  for(let i=0;i<=4;i++){
    const y=bottom-range*i/4;ctx.strokeStyle="#334242";ctx.beginPath();ctx.moveTo(left,y);ctx.lineTo(right,y);ctx.stroke();
    ctx.fillStyle="#a1b2ab";ctx.fillText(fmt(i*max/4),8,y+3);
  }
  days.forEach((d,i)=>{
    modes.forEach((m,j)=>{
      const v=daily[m].get(d)?.active||0;
      if(!v)return;
      const bw=Math.min(15,step/4), bh=v/max*range;
      ctx.fillStyle=colors[m];ctx.fillRect(left+step*(i+.5)+(j-1.5)*bw,bottom-bh,bw-1,bh);
    });
    if(i%Math.max(1,Math.ceil(48/step))===0){
      ctx.fillStyle="#a1b2ab";ctx.textAlign="center";ctx.fillText(dateLabel(d).slice(0,5),left+step*(i+.5),bottom+16);
    }
  });
}
function renderTables(){
  const days=[...known];
  let both=0,gap=0;
  for(const d of days){
    const m=daily.modis.get(d)?.active||0,v=daily.viirs.get(d)?.active||0;
    if(m&&v){both++;gap+=Math.abs(m-v);}
  }
  const note=document.createElement("p");note.className="note";
  note.textContent=both?"Días con celdas activas en ambas corridas: "+both+" · Diferencia absoluta media: "+fmt(gap/both)+" celdas. Cobertura sin verificar.":"No hay días con celdas activas en ambas corridas para comparar en la selección.";
  const key=r=>r[0]+"|"+r[1]+"|"+r[2];
  const mSet=new Set(cells.modis.ref.map(key)),vSet=new Set(cells.viirs.ref.map(key));
  const intersection=[...mSet].filter(k=>vSet.has(k)).length;
  const union=mSet.size+vSet.size-intersection;
  const evidence=document.createElement("p");evidence.className="note";
  evidence.textContent=union
    ? "Coincidencia espacial y diaria (Jaccard): "+fmt(100*intersection/union)+"% · "+num(intersection)+" de "+num(union)+" celdas-día. Sin máscaras válidas y pasadas comparables, este resultado no permite atribuir las diferencias al sensor."
    : "Sin celdas activas en las corridas individuales para medir el solapamiento.";
  $("comparison").replaceChildren(note,evidence);
  const periods=new Map();
  for(const d of days)for(const key of [d.slice(0,4),d.slice(0,7)]){
    const x=periods.get(key)||[0,0,0];
    const item=daily.ambos.get(d);x[0]++;x[1]+=item?.active||0;x[2]+=item?.energy||0;periods.set(key,x);
  }
  showTable("periods",["Período","Días procesados","Celdas activas × día","Energía estimada (MWh)","Anomalía histórica"],
    [...periods.entries()].map(([key,[d,a,e]])=>[key,d,a?num(a):"—",e?fmt(e):"—","Sin referencia"]));
}
function zoom(f,x=mapWidth/2,y=mapHeight/2){
  if(!data)return;
  const z=Math.min(256,Math.max(.65,viewport.scale*f)),ratio=z/viewport.scale;
  viewport.x=(x-mapWidth/2)*(1-ratio)+viewport.x*ratio;
  viewport.y=(y-mapHeight/2)*(1-ratio)+viewport.y*ratio;
  viewport.scale=z;renderMap();
}
function csv(filename,cols,items){
  const quote=v=>'"'+String(v??"").replaceAll('"','""')+'"';
  const blob=new Blob(["\ufeff",...[cols,...items].map(r=>r.map(quote).join(",")+"\r\n")],{type:"text/csv;charset=utf-8"});
  const url=URL.createObjectURL(blob);download(url,filename);setTimeout(()=>URL.revokeObjectURL(url),2000);
}
function download(url,name){const a=document.createElement("a");a.href=url;a.download=name;a.click();}
map.onpointerdown=e=>{
  map.setPointerCapture(e.pointerId);
  if(drawMode||e.shiftKey){
    boxDrag={x0:e.offsetX,y0:e.offsetY,x1:e.offsetX,y1:e.offsetY};
    return;
  }
  drag={x:e.offsetX,y:e.offsetY,vx:viewport.x,vy:viewport.y};
};
map.onpointermove=e=>{
  if(boxDrag){boxDrag.x1=e.offsetX;boxDrag.y1=e.offsetY;renderMap();return;}
  if(!drag)return;
  viewport.x=drag.vx+e.offsetX-drag.x;viewport.y=drag.vy+e.offsetY-drag.y;renderMap();
};
map.onpointerup=e=>{
  if(boxDrag){
    const {x0,y0,x1,y1}=boxDrag;boxDrag=null;setDrawMode(false);
    if(lastProj&&Math.hypot(x1-x0,y1-y0)>=6){
      const [lonA,latA]=lastProj.toLonLat(x0,y0),[lonB,latB]=lastProj.toLonLat(x1,y1);
      area={type:"box",minLat:Math.min(latA,latB),maxLat:Math.max(latA,latB),minLon:Math.min(lonA,lonB),maxLon:Math.max(lonA,lonB)};
      $("lat").value=((area.minLat+area.maxLat)/2).toFixed(4);
      $("lon").value=((area.minLon+area.maxLon)/2).toFixed(4);
      apply();
    }else if(lastProj){
      const [lon,lat]=lastProj.toLonLat(x1,y1);
      const rKm=Math.max(0.1,Number($("radius").value)||10);
      area={type:"circle",lat,lon,rKm};
      $("lat").value=lat.toFixed(4);$("lon").value=lon.toFixed(4);
      apply();
    }else renderMap();
    return;
  }
  if(drag&&Math.hypot(e.offsetX-drag.x,e.offsetY-drag.y)<5){
    const hit=targets.findLast(([x,y,w,h])=>e.offsetX>=x-2&&e.offsetX<=x+w+2&&e.offsetY>=y-2&&e.offsetY<=y+h+2);
    const coords=lastProj?(()=>{const [lon,lat]=lastProj.toLonLat(e.offsetX,e.offsetY);return " ("+fmt(lat)+"°, "+fmt(lon)+"°)";})():"";
    $("inspect").textContent=(hit?.[4]||"Sin celdas activas ni detecciones en este punto para la capa seleccionada.")+coords;
  }
  drag=null;
};
map.onpointercancel=()=>{drag=null;boxDrag=null;};
map.ondblclick=e=>zoom(2,e.offsetX,e.offsetY);
map.addEventListener("wheel",e=>{e.preventDefault();zoom(e.deltaY<0?1.25:.8,e.offsetX,e.offsetY);},{passive:false});
map.addEventListener("keydown",e=>{
  const steps={ArrowLeft:[30,0],ArrowRight:[-30,0],ArrowUp:[0,30],ArrowDown:[0,-30]};
  if(e.key==="+"||e.key==="="){e.preventDefault();zoom(1.5);}
  if(e.key==="-"){e.preventDefault();zoom(2/3);}
  if(steps[e.key]){e.preventDefault();viewport.x+=steps[e.key][0];viewport.y+=steps[e.key][1];renderMap();}
});
$("plus").onclick=()=>zoom(1.55);$("minus").onclick=()=>zoom(1/1.55);
$("home").onclick=()=>{viewport={scale:1,x:0,y:0};renderMap();};
$("layer").onchange=renderMap;
$("prev").onclick=()=>{if(!month)return;month.setUTCDate(1);month.setUTCMonth(month.getUTCMonth()-1);renderCalendar();};
$("next").onclick=()=>{if(!month)return;month.setUTCDate(1);month.setUTCMonth(month.getUTCMonth()+1);renderCalendar();};
$("all-days").onclick=()=>{if(!start)return;selected=null;fireRange=null;renderCalendar();renderFireCalendar();renderMap();};
$("filters").onsubmit=e=>{e.preventDefault();apply();downloadMissing();};
$("filters").onchange=apply;
$("area-form").onsubmit=e=>{
  e.preventDefault();
  const lat=parseFloat($("lat").value),lon=parseFloat($("lon").value),rKm=Math.max(0.1,parseFloat($("radius").value)||10);
  if(!Number.isFinite(lat)||!Number.isFinite(lon)||lat<-90||lat>90||lon<-180||lon>180){
    $("area-status").classList.add("warn");
    $("area-status").textContent="Ingresá una latitud (entre -90 y 90) y longitud (entre -180 y 180) válidas.";
    return;
  }
  setDrawMode(false);
  area={type:"circle",lat,lon,rKm};
  const [, ,kx,ky]=data.grid;
  focusBounds(lon-rKm/kx,lon+rKm/kx,lat-rKm/ky,lat+rKm/ky);
  apply();
};
$("draw-btn").onclick=()=>setDrawMode(!drawMode);
$("draw-map").onclick=()=>setDrawMode(!drawMode);
$("clear-area").onclick=()=>{
  area=null;setDrawMode(false);
  $("lat").value="";$("lon").value="";
  viewport={scale:1,x:0,y:0};
  apply();
};
document.addEventListener("keydown",e=>{if(e.key==="Escape"&&drawMode){setDrawMode(false);boxDrag=null;renderMap();}});
for(const btn of document.querySelectorAll("#incendios [data-scale]")){
  btn.onclick=()=>{
    fireScale=btn.dataset.scale;
    for(const b of document.querySelectorAll("#incendios [data-scale]"))b.setAttribute("aria-pressed",String(b===btn));
    renderFireCalendar();
  };
}
$("fc-prev").onclick=()=>{
  if(fireScale==="day"&&fcMonth){fcMonth.setUTCDate(1);fcMonth.setUTCMonth(fcMonth.getUTCMonth()-1);renderFireCalendar();}
  else if(fireScale==="month"&&fcYear){fcYear--;renderFireCalendar();}
};
$("fc-next").onclick=()=>{
  if(fireScale==="day"&&fcMonth){fcMonth.setUTCDate(1);fcMonth.setUTCMonth(fcMonth.getUTCMonth()+1);renderFireCalendar();}
  else if(fireScale==="month"&&fcYear){fcYear++;renderFireCalendar();}
};

function addResults(extra) {
  if(!data || !Array.isArray(extra?.dates) || !extra.dates.length ||
     !Array.isArray(extra.rows) || !modes.every(m=>Array.isArray(extra.products?.[m])) ||
     !Array.isArray(extra.grid) || extra.grid.length!==5 || !data.grid.every((v,i)=>v===extra.grid[i]) ||
     new Set(extra.dates).size!==extra.dates.length ||
     !extra.dates.every(d=>typeof d==="string" && /^\d{4}-\d{2}-\d{2}$/.test(d) &&
       Number.isFinite(dayObject(d).getTime()) && dayISO(dayObject(d))===d)) {
    throw new Error("El archivo no tiene el formato LETKF del atlas de San Juan.");
  }
  const included=new Set(extra.dates);
  if(!extra.rows.every(r=>Array.isArray(r)&&r.length===14&&included.has(r[1])&&
       Number.isFinite(r[2])&&Number.isFinite(r[3])&&["MODIS","VIIRS"].includes(r[5])) ||
     !modes.every(m=>extra.products[m].every(r=>Array.isArray(r)&&r.length===5&&
       r.slice(0,4).every(Number.isFinite)&&Number.isInteger(r[0])&&extra.dates[r[0]]&&r[3]>=0))) {
    throw new Error("El archivo tiene celdas o detecciones con fechas incompatibles.");
  }
  const dates=[...new Set([...data.dates,...extra.dates])].sort();
  const ix=new Map(dates.map((d,i)=>[d,i]));
  const products=Object.fromEntries(modes.map(m=>[m,[
    ...data.products[m].filter(r=>!included.has(data.dates[r[0]])).map(r=>[ix.get(data.dates[r[0]]),...r.slice(1)]),
    ...extra.products[m].map(r=>[ix.get(extra.dates[r[0]]),...r.slice(1)])
  ]]));
  data={...data,dates,products,rows:[...data.rows.filter(r=>!included.has(r[1])),...extra.rows]
    .sort((a,b)=>a[0].localeCompare(b[0]))};
  lastComputed=data;
  $("save-letkf").disabled=false;
  apply();
}

$("save-letkf").onclick=()=>{
  if(!lastComputed)return;
  const url=URL.createObjectURL(new Blob([JSON.stringify(lastComputed)],{type:"application/json"}));
  download(url,"letkf-san-juan-"+lastComputed.dates[0]+".json");
  setTimeout(()=>URL.revokeObjectURL(url),2000);
};

function progress(message) {
  $("data-panel").hidden=false;
  $("data-panel").open=true;
  $("compute-status").textContent=message;
}

function finishWorker(){
  worker?.terminate();worker=null;
  $("analyze").disabled=false;
  $("stop-letkf").hidden=true;
}
$("stop-letkf").onclick=()=>{
  finishWorker();progress("Proceso cancelado. Los bloques ya calculados siguen disponibles.");
};

function runWorker(payload){
  if(worker)return;
  try{worker=new Worker("letkf-worker.js?v=6");}
  catch{progress("No se pudo iniciar el motor LETKF.");return;}
  $("analyze").disabled=true;$("stop-letkf").hidden=false;
  progress("Iniciando el análisis…");
  let computed=0,empty=0;
  worker.onmessage=({data:message})=>{
    try{
      if(message.status){progress(message.status);return;}
      if(message.error)throw new Error(message.error);
      if(message.result){
        const result=JSON.parse(message.result);
        addResults(result);computed+=result.dates.length;
      }
      if(message.empty){
        const [a,b]=message.empty.map(dayObject);
        for(let d=a;d<=b;d.setUTCDate(d.getUTCDate()+1)){
          checkedWithoutData.add(dayISO(d));empty++;
        }
      }
      if(message.done){
        progress(computed
          ? "LETKF actualizado · "+num(computed)+" días incorporados."+
            (empty?" Sin detecciones utilizables en otros "+num(empty)+" días consultados.":"")
          : "FIRMS no devolvió detecciones utilizables para las fechas pendientes. La cobertura satelital sigue sin verificar.");
        finishWorker();
      }
    }catch(error){finishWorker();progress("No se pudo completar el análisis. "+error.message);}
  };
  worker.onerror=()=>{finishWorker();progress("No se pudo contactar FIRMS o iniciar el motor LETKF. Volvé a pulsar Analizar para reintentar.");};
  worker.postMessage(payload);
}

function downloadMissing() {
  if(worker||!data)return;
  const a=$("desde").value,b=$("hasta").value;
  if(!a||!b||a>b)return;
  const last=dayISO(new Date(Date.now()-3*3600000));
  const latest=b<last?b:last;
  if(a>latest){progress("El intervalo está en el futuro.");return;}
  const existing=[...data.dates,...checkedWithoutData];
  const visible=new Set(existing);
  let pending=false;
  for(let d=dayObject(a);dayISO(d)<=latest;d.setUTCDate(d.getUTCDate()+1)){
    if(!visible.has(dayISO(d))){pending=true;break;}
  }
  if(!pending){
    if($("data-panel").open)progress("Este intervalo ya se consultó en esta sesión.");
    return;
  }
  runWorker({start:a,end:latest,existing});
}

$("export-raw").onclick=()=>csv("detecciones-firms-san-juan.csv",["fecha_hora_utc","fecha_san_juan","latitud","longitud","plataforma","sensor","frp_mw","scan_km","track_km","confianza","departamento","tipo","dia_noche","version"],rows);
$("export-summary").onclick=()=>{
  if(!known.size)return;
  const records=[];
  for(const key of known){
    const v=daily.ambos.get(key);
    records.push([key,region||"San Juan",known.has(key)?"procesado_sin_cobertura_verificada":"fuera_de_datos",v?.active||null,daily.modis.get(key)?.active||null,daily.viirs.get(key)?.active||null,v?.energy||null,threshold]);
  }
  csv("calendario-san-juan.csv",["fecha","region","estado","celdas_letkf_ambos","celdas_letkf_modis","celdas_letkf_viirs","energia_letkf_mwh","umbral_mwh"],records);
};
$("export-cells").onclick=()=>{
  if(!data)return;
  const [west,south,kx,ky,cell]=data.grid;
  const records=cells.ambos.ref.map(([d,x,y,e])=>[data.dates[d],x+"/"+y,south+(y+2)*cell/ky,west+(x+2)*cell/kx,1.5,Number(e.toFixed(3)),threshold,region||"San Juan"]);
  csv("celdas-letkf-san-juan.csv",["fecha","id_celda","lat_centro","lon_centro","lado_km","energia_mwh","umbral_mwh","region"],records);
};
$("export-map").onclick=()=>download(map.toDataURL(),"mapa-san-juan.png");
$("export-chart").onclick=()=>download(chart.toDataURL(),"comparacion-san-juan.png");
new ResizeObserver(()=>{if(start){renderMap();renderChart();}}).observe($("filters"));
Promise.all(["datos.json","san-juan.json"].map(async file=>{
  const r=await fetch(file);if(!r.ok)throw new Error(file);return r.json();
})).then(([d,g])=>{
  data=d;geo=g;
  for(const name of geo.features.map(f=>f.properties.nombre).sort(sorted))$("region").add(new Option(name,name));
  dateQuery.restoreRegion($("region"));
  $("desde").value=dateQuery.readDate("desde",data.dates[0]);
  $("hasta").value=dateQuery.readDate("hasta",data.dates.at(-1));
  apply();
}).catch(()=>{$("status").textContent="No se pudieron cargar las detecciones y estimaciones. Recargá la página para volver a intentar.";});
