import express from "express";
import path from "node:path";
import fs from "node:fs";
import { app } from "./server.js";
import { CONFIG } from "./config.js";

const devApp = express();

const publicDir = path.resolve(process.cwd(), "public");

// In local dev, serve compiled/static assets from public/
if (fs.existsSync(publicDir)) {
  devApp.use(express.static(publicDir));
} else {
  // If public hasn't been built yet, serve source static files as fallback
  devApp.use(express.static(process.cwd()));
}

// Mount the API application
devApp.use(app);

// Fallback to index.html for root if not resolved
devApp.get("/", (_req, res) => {
  const indexInPublic = path.join(publicDir, "index.html");
  if (fs.existsSync(indexInPublic)) {
    res.sendFile(indexInPublic);
  } else {
    res.sendFile(path.resolve(process.cwd(), "index.html"));
  }
});

// Fallback to app.html for /app
devApp.get("/app", (_req, res) => {
  const appInPublic = path.join(publicDir, "app.html");
  if (fs.existsSync(appInPublic)) {
    res.sendFile(appInPublic);
  } else {
    res.sendFile(path.resolve(process.cwd(), "app.html"));
  }
});

devApp.listen(CONFIG.PORT, () => {
  console.log(`\n==============================================`);
  console.log(` Nexus MVP Server listening on http://localhost:${CONFIG.PORT}`);
  console.log(` Marketing Page: http://localhost:${CONFIG.PORT}/`);
  console.log(` Dashboard:      http://localhost:${CONFIG.PORT}/app.html`);
  console.log(` Widget Embed:   http://localhost:${CONFIG.PORT}/nexus.js`);
  console.log(`==============================================\n`);
});
