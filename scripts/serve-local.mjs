import {createServer} from "node:http";
import {Readable} from "node:stream";
import worker from "../dist/server/index.js";

const origin = "http://127.0.0.1:8080";
createServer(async (incoming, outgoing) => {
  try {
    const method = incoming.method;
    const url = new URL(incoming.url, origin);
    const options = {method, headers: incoming.headers};
    if (method !== "GET" && method !== "HEAD") {
      options.body = Readable.toWeb(incoming);
      options.duplex = "half";
    }
    const response = await worker.fetch(new Request(url, options), process.env);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) Readable.fromWeb(response.body).pipe(outgoing);
    else outgoing.end();
  } catch {
    outgoing.writeHead(500, {"Content-Type": "text/plain; charset=utf-8"});
    outgoing.end("No se pudo atender la consulta local.");
  }
}).listen(8080, "127.0.0.1", () => console.log(origin));
