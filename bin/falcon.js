#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distEntry = join(__dirname, "../dist/index.js");
const srcEntry = join(__dirname, "../src/index.ts");

const entry = existsSync(distEntry) ? distEntry : srcEntry;
const { cli } = await import(entry);

await cli();
