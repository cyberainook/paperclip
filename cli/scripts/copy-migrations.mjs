import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(cliRoot, "../packages/db/src/migrations");
const target = resolve(cliRoot, "dist/migrations");

if (!existsSync(source)) {
  throw new Error(`Cannot package database migrations: source directory is missing at ${source}`);
}

rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });
