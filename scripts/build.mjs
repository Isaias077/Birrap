import {readFile, readdir, mkdir, writeFile, copyFile} from "node:fs/promises";

const assets = Object.fromEntries(await Promise.all((await readdir("web")).map(async name=>[
  "/" + name,(await readFile("web/" + name)).toString("base64")
])));
const source = await readFile("worker/index.js","utf8");
await mkdir("dist/server",{recursive:true});
await mkdir("dist/.openai",{recursive:true});
await writeFile("dist/server/index.js",source+"\nconst assets = "+JSON.stringify(assets)+";\n");
await copyFile(".openai/hosting.json","dist/.openai/hosting.json");
