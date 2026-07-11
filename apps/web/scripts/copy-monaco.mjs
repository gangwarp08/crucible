// Copies the Monaco editor min build into public/ so the candidate IDE loads it
// from OUR origin (/monaco/vs) instead of a CDN. Run automatically by the
// `build` script (pnpm doesn't run pre/post hooks), and available as
// `pnpm --filter web copy-monaco` for local dev.
//
// monaco-editor is a direct dependency of apps/web, so it resolves under
// apps/web/node_modules. We clean the destination first so stale chunks from a
// previous Monaco version can never linger, then recursive-copy the min build.
import { cp, rm, mkdir, access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(__dirname, "..");

const src = resolve(webRoot, "node_modules/monaco-editor/min/vs");
const dest = resolve(webRoot, "public/monaco/vs");

try {
  await access(src);
} catch {
  console.error(
    `[copy-monaco] source not found: ${src}\n` +
      "Is monaco-editor installed? Run `pnpm install` first.",
  );
  process.exit(1);
}

await rm(dest, { recursive: true, force: true });
await mkdir(dirname(dest), { recursive: true });
await cp(src, dest, { recursive: true });

console.log(`[copy-monaco] copied ${src} -> ${dest}`);
