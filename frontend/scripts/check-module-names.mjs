// TypeScript resolves ".ts" before ".tsx". On case-insensitive macOS,
// WavWaveform.tsx and wavWaveform.ts are ambiguous, even though Linux builds.
// Reject conflicting module stems on all platforms before tsc/vite.
import { readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../src/", import.meta.url));
const extensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"]);
let failed = false;

async function checkDirectory(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const modules = new Map();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const extension = extname(entry.name);
    if (!extensions.has(extension)) continue;
    const stem = entry.name.slice(0, -extension.length);
    const key = stem.normalize("NFC").toLocaleLowerCase("en-US");
    const first = modules.get(key);
    if (first) {
      console.error("Module name collision (case-insensitive import): " +
        join(relative(root, directory), first) + " / " +
        join(relative(root, directory), entry.name));
      failed = true;
    } else {
      modules.set(key, entry.name);
    }
  }
  for (const entry of entries) {
    if (entry.isDirectory()) await checkDirectory(join(directory, entry.name));
  }
}

await checkDirectory(root);
if (failed) process.exitCode = 1;
