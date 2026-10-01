// Serve the local shadow + iframe penetration demo so it can be opened in the
// JEV Web Control dashboard. Run `npm run demo:serve`, then point
// the dashboard URL at http://127.0.0.1:8123/examples/shadow_iframe_demo.html
// to see 3-scope penetration (主文档 / ::shadow / iframe) with overlay boxes.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url)); // examples/
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

const server = createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "");
  if (p === "" || p === "shadow_iframe_demo.html") p = "shadow_iframe_demo.html";
  const file = join(ROOT, p);
  try {
    const body = readFileSync(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] || "text/plain" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});

server.listen(8123, () =>
  console.log("demo served at http://127.0.0.1:8123/examples/shadow_iframe_demo.html")
);
