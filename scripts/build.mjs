import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";

const rootDir = process.cwd();
const publicDir = path.join(rootDir, "public");

// Ensure public directory exists
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
}

console.log("Building client bundles...");

// 1. Bundle client scripts
await esbuild.build({
  entryPoints: [
    path.join(rootDir, "src/client/site.ts"),
    path.join(rootDir, "src/client/dashboard.ts")
  ],
  bundle: true,
  outdir: publicDir,
  format: "esm",
  target: "es2022",
  sourcemap: true,
  minify: process.env.NODE_ENV === "production"
});

// 2. Copy static files into public
fs.copyFileSync(path.join(rootDir, "index.html"), path.join(publicDir, "index.html"));
if (fs.existsSync(path.join(rootDir, "app.html"))) {
  fs.copyFileSync(path.join(rootDir, "app.html"), path.join(publicDir, "app.html"));
}
fs.copyFileSync(path.join(rootDir, "nexus.js"), path.join(publicDir, "nexus.js"));

console.log("Build complete! Emitted static assets into public/");
