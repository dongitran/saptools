#!/usr/bin/env node

import { createServer } from "node:http";

const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => {
    chunks.push(chunk);
  });
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    res.statusCode = 201;
    res.setHeader("content-type", "application/json");
    res.setHeader("x-fixture", "cf-live-trace");
    res.end(JSON.stringify({
      ok: true,
      method: req.method,
      url: req.url,
      body,
    }));
  });
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  process.stdout.write(`HTTP_READY ${port}\n`);
});

process.once("SIGTERM", () => {
  server.close(() => {
    process.exit(0);
  });
});
