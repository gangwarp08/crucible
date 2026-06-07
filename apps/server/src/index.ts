import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
// Load repo-root .env regardless of CWD (src/ is 3 levels below the repo root)
config({ path: resolve(__dir, "../../../.env") });

import { buildServer } from "./server.js";
import { env } from "./env.js";

const server = await buildServer();

try {
  await server.listen({ port: env.PORT, host: env.HOST });
  console.log(`Server listening on http://${env.HOST}:${env.PORT}`);
} catch (err) {
  server.log.error(err);
  process.exit(1);
}
