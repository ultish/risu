import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/** Loads the repo-root .env (if present) before anything else reads process.env. */
const envPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../.env",
);
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}
