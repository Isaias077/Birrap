// Servicio Vercel "api": recibe la ruta pública original (/api/...).
import {firms, reply} from "./firms.js";

export default {
  async fetch(request) {
    const {pathname}=new URL(request.url);
    if(pathname==="/api/firms")return firms(request,process.env);
    return reply("Ruta no encontrada.",404);
  }
};
