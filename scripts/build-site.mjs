// Builds the static Fitto site into _site/: copies site/public and bundles site/src with esbuild.
// Personal data is never part of the build; the workflow adds only the encrypted data/matches.enc.json.
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

const out = process.argv[2] ?? "_site";
rmSync(out, { recursive: true, force: true });
mkdirSync(`${out}/assets`, { recursive: true });
cpSync("site/public", out, { recursive: true });
await build({
  entryPoints: { app: "site/src/app.ts", theme: "site/src/theme.ts" },
  outdir: `${out}/assets`,
  bundle: true,
  format: "iife",
  target: "es2022",
  minify: true,
  sourcemap: false,
  legalComments: "none",
  logLevel: "warning",
});
console.log(`site built in ${out}/`);