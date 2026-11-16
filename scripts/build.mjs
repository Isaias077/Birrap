import {readFile, readdir, mkdir, writeFile, copyFile} from "node:fs/promises";

const assets = Object.fromEntries(await Promise.all((await readdir("web")).map(async name=>[
  "/" + name,(await readFile("web/" + name)).toString("base64")
])));
// El Worker se publica como un único archivo: se incrusta el módulo compartido
// api/firms.js (también usado por el servicio Vercel) quitando import/export.
const shared = (await readFile("api/firms.js","utf8")).replace(/^export\s+(?=(const|async|function))/gm,"");
const source = (await readFile("worker/index.js","utf8")).replace(/^import\s.*from\s+["']\.\.\/api\/firms\.js["'];?\r?\n/m,"");
await mkdir("dist/server",{recursive:true});
await mkdir("dist/.openai",{recursive:true});
await writeFile("dist/server/index.js",shared+"\n"+source+"\nconst assets = "+JSON.stringify(assets)+";\n");
await copyFile(".openai/hosting.json","dist/.openai/hosting.json");
