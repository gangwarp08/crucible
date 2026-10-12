// Default IDV provider — LiteLLM gateway vision compare.
//
// Extracted verbatim from services/proctoring-v2.ts (slice V3 refactor,
// behavior-neutral). Hard Rule 3: models are reached ONLY through
// LITELLM_BASE_URL; provider keys live on the gateway. Authenticates with the
// session's own minted key so the call is bounded by the session budget like
// every other model call in the session.
//
// The images exist only in this request body — never logged, never stored.
// On a non-OK response we surface the STATUS ONLY (never the response body,
// which can echo the request payload — i.e. the base64 images — straight into
// our logs).
//
// This provider measures match confidence only; it has NO liveness signal
// (livenessScore: null). A certified vendor (persona.ts / hyperverge.ts) is
// the upgrade path when liveness is required.

import { env } from "../../env.js";
import { sessionRegistry } from "../registry.js";
import { IdvProviderError, type IdvProvider } from "./types.js";

export const gatewayVisionProvider: IdvProvider = {
  name: "gateway-vision",

  async verifyIdentity(idImage, selfieImage, sessionId) {
    const entry = sessionRegistry.get(sessionId);
    const sessionKey = entry?.litellmKey;
    if (!sessionKey) {
      throw new IdvProviderError("session not live — no session key for the vision call");
    }

    const res = await fetch(`${env.LITELLM_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sessionKey}`, // session key — never the master key
      },
      body: JSON.stringify({
        model: "gemini-flash",
        response_format: { type: "json_object" },
        max_tokens: 100,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  "You are verifying a test-taker's identity. The first image is a " +
                  "photo of a government ID; the second is a live selfie. Estimate " +
                  "the probability that the person on the ID and the person in the " +
                  "selfie are the SAME person. Consider face shape, features, and " +
                  "obvious mismatches; be conservative when either image is " +
                  "unreadable or contains no face (low confidence). Respond with " +
                  'ONLY this JSON: {"same_person_confidence": <number 0..1>}',
              },
              { type: "image_url", image_url: { url: idImage } },
              { type: "image_url", image_url: { url: selfieImage } },
            ],
          },
        ],
      }),
    });

    if (!res.ok) {
      // STATUS ONLY — never the body (it can echo the images; see header).
      throw new IdvProviderError(`gateway vision call failed: HTTP ${res.status}`);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = data.choices?.[0]?.message?.content ?? "";
    let conf: unknown;
    try {
      conf = (JSON.parse(text) as Record<string, unknown>)["same_person_confidence"];
    } catch {
      throw new IdvProviderError("gateway vision call returned non-JSON content");
    }
    if (typeof conf !== "number" || !Number.isFinite(conf)) {
      throw new IdvProviderError("gateway vision call returned no numeric confidence");
    }
    return {
      matchConfidence: Math.max(0, Math.min(1, conf)),
      livenessScore: null, // this provider cannot measure liveness
    };
  },
};
