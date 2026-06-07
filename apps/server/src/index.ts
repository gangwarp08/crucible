import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
// Must run before any other module import, because static imports are hoisted in ESM.
// env.ts calls loadEnv() at module evaluation time, so it must see process.env
// after dotenv has populated it.
config({ path: resolve(__dir, "../../../.env") });

// Dynamic imports execute in order (not hoisted), so dotenv is already applied.
const { buildServer } = await import("./server.js");
const { env } = await import("./env.js");

const server = await buildServer();

try {
  await server.listen({ port: env.PORT, host: env.HOST });
  console.log(`Server listening on http://${env.HOST}:${env.PORT}`);
} catch (err) {
  server.log.error(err);
  process.exit(1);
}
