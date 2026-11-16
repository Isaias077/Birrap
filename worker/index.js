import {firms, reply} from "../api/firms.js";

const types = {
  html:"text/html; charset=utf-8", css:"text/css; charset=utf-8",
  js:"text/javascript; charset=utf-8", json:"application/json",
  csv:"text/csv; charset=utf-8", zip:"application/zip"
};

export default {
  async fetch(request,env) {
    const {pathname}=new URL(request.url);
    if(pathname==="/api/firms")return firms(request,env);
    if(request.method!=="GET"&&request.method!=="HEAD")return reply("Método no permitido.",405);
    const path=pathname==="/"?"/index.html":pathname;
    if(!Object.hasOwn(assets,path))return new Response("Página no encontrada",{status:404});
    const bytes=Uint8Array.from(atob(assets[path]), c=>c.charCodeAt(0));
    return new Response(request.method==="HEAD"?null:bytes,{headers:{
      "Content-Type":types[path.split(".").at(-1)]||"application/octet-stream",
      "Cache-Control":"no-cache","X-Content-Type-Options":"nosniff"
    }});
  }
};
