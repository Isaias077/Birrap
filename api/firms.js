// Proxy a NASA FIRMS. Compartido por el servicio Vercel (api/index.js) y el
// Worker empaquetado por scripts/build.mjs (que copia este archivo sin "export").
// Clave NASA FIRMS incrustada a pedido. La variable de entorno FIRMS_MAP_KEY, si existe, tiene prioridad.
const FIRMS_MAP_KEY_DEFAULT = "886fbfe84331ca5604e368739a65e172";
const nasa = ["https://firms.modaps.eosdis.nasa.gov","https://firms2.modaps.eosdis.nasa.gov"];
const sensors = new Set([
  "MODIS_SP","MODIS_NRT","VIIRS_SNPP_SP","VIIRS_SNPP_NRT",
  "VIIRS_NOAA20_SP","VIIRS_NOAA20_NRT","VIIRS_NOAA21_SP","VIIRS_NOAA21_NRT"
]);
export const reply = (message,status=400) => Response.json({error:message},{status,headers:{"Cache-Control":"no-store"}});
const validDate = value => {
  if(typeof value!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
  const date=new Date(value+"T00:00:00Z");
  return Number.isFinite(+date)&&date.toISOString().slice(0,10)===value;
};
// Detrás del proxy de Vercel request.url puede no reflejar el host público,
// así que también se aceptan los encabezados Host / X-Forwarded-Host.
const sameOrigin = request => {
  const origin=request.headers.get("Origin");
  if(!origin)return true;
  let originHost;
  try{originHost=new URL(origin).host;}catch{return false;}
  const allowed=new Set([new URL(request.url).host]);
  for(const name of ["x-forwarded-host","host"]){
    const value=request.headers.get(name);
    if(value)allowed.add(value.split(",")[0].trim());
  }
  return allowed.has(originHost);
};

export async function firms(request,env) {
  if(request.method!=="POST")return reply("Usá POST.",405);
  if(!sameOrigin(request))return reply("Origen no permitido.",403);
  let input;
  try{input=await request.json();}catch{return reply("Consulta inválida.");}
  if(!input||typeof input!=="object")return reply("Consulta inválida.");
  const {type,source,start,days}=input;
  if(type!=="availability" && (type!=="area"||!sensors.has(source)||
     !validDate(start)||!Number.isInteger(days)||days<1||days>5)){
    return reply("Fuente o intervalo FIRMS inválido.");
  }
  const key=env?.FIRMS_MAP_KEY||FIRMS_MAP_KEY_DEFAULT;
  if(typeof key!=="string"||!/^[-_a-zA-Z0-9]{8,128}$/.test(key)){
    return reply("La conexión con NASA FIRMS todavía no está configurada en el servidor.",503);
  }
  const path=type==="availability"?"/api/data_availability/csv/"+key+"/ALL":
    "/api/area/csv/"+key+"/"+source+"/-71,-33,-65,-27/"+days+"/"+start;
  let response,csv;
  for(const origin of nasa){
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),12000);
    try{
      let endpoint=origin+path;
      for(let redirect=0;redirect<3;redirect++){
        response=await fetch(endpoint,{redirect:"manual",signal:controller.signal});
        if(![301,302,303,307,308].includes(response.status))break;
        const location=response.headers.get("Location");
        const next=location&&new URL(location,endpoint);
        if(!next||!nasa.includes(next.origin))throw new Error("Redirección externa");
        endpoint=next.href;
      }
      csv=await response.text();
      if(response.status<500)break;
    }catch(error){
      console.warn("FIRMS upstream",origin,String(error.message||error).replaceAll(key,"[oculto]").slice(0,180));
      response=null;
    }finally{clearTimeout(timer);}
  }
  if(!response)return reply("NASA FIRMS no respondió. Podés reintentar.",502);
  if(response.status===429||/transaction limit|too many requests|rate limit/i.test(csv)){
    return reply("NASA FIRMS alcanzó el límite de consultas. Reintentá más tarde.",429);
  }
  if(/invalid.*map.?key|map.?key.*(invalid|not valid|not found)|invalid key/i.test(csv)){
    return reply("NASA FIRMS rechazó la credencial del servidor.",502);
  }
  const header=csv.trimStart().split(/\r?\n/,1)[0].toLowerCase();
  const expected=type==="availability"?[/(data_id|source|sensor)/,/min_date|start_date/,/max_date|end_date/]:[/latitude/,/longitude/,/acq_date/,/frp/];
  if(!response.ok||!expected.every(pattern=>pattern.test(header))){
    return reply("NASA FIRMS no devolvió un CSV válido"+(source?" para "+source+" desde "+start:"")+".",502);
  }
  return new Response(csv,{headers:{"Content-Type":"text/csv; charset=utf-8","Cache-Control":"no-store"}});
}
