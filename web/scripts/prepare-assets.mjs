import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "node_modules", "stockfish", "bin");
const target = resolve(root, "public", "engine");

await mkdir(target, { recursive: true });
for (const name of [
  "stockfish-18-lite-single.js",
  "stockfish-18-lite-single.wasm",
]) {
  await copyFile(resolve(source, name), resolve(target, name));
}
