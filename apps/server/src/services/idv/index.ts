// IDV provider registry — env-selected (IDV_PROVIDER, default gateway-vision).
//
// The seam between "buy" and "build": proctoring-v2.ts calls
// getIdvProvider().verifyIdentity(...) and neither knows nor cares whether the
// comparison ran on our gateway or a certified vendor. Swapping vendors is an
// env change plus (for a new vendor) one adapter file.

import { env } from "../../env.js";
import type { IdvProvider } from "./types.js";
import { gatewayVisionProvider } from "./gateway-vision.js";
import { personaProvider } from "./persona.js";
import { hypervergeProvider } from "./hyperverge.js";

export { IdvProviderError, type IdvProvider, type IdvResult } from "./types.js";
export { gatewayVisionProvider } from "./gateway-vision.js";

const PROVIDERS: Record<string, IdvProvider> = {
  "gateway-vision": gatewayVisionProvider,
  persona: personaProvider,
  hyperverge: hypervergeProvider,
};

/** Resolve the configured IDV provider. Unknown values fall back to the
 *  gateway default LOUDLY (boot-time env validation already constrains the
 *  enum; this guard covers direct callers in tests). */
export function getIdvProvider(): IdvProvider {
  const name = env.IDV_PROVIDER ?? "gateway-vision";
  const provider = PROVIDERS[name];
  if (!provider) {
    console.warn(`[idv] unknown IDV_PROVIDER "${name}" — falling back to gateway-vision`);
    return gatewayVisionProvider;
  }
  return provider;
}
