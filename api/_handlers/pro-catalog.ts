/**
 * Public Pro catalog (plans + enabled features) for the client tariff UI.
 */
import { getProCatalogConfig } from "../../database/proCatalogConfig.js";
import {
  DEFAULT_PRO_CATALOG,
  buildProPlansFromCatalog,
  computeLaunchDiscountUsd,
  computeProMonthPrice,
  enabledProFeatureIds,
  type ProCatalogConfig,
} from "../../shared/proCatalog.js";

type NodeRes = {
  setHeader(name: string, value: string): void;
  status(code: number): void;
  end(body?: string): void;
};

function jsonResponse(body: object, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function respond(res: NodeRes | undefined, body: object, status: number): Response | void {
  if (res) {
    res.setHeader("Content-Type", "application/json");
    res.status(status);
    res.end(JSON.stringify(body));
    return;
  }
  return jsonResponse(body, status);
}

function catalogPayload(cfg: ProCatalogConfig) {
  const plans = buildProPlansFromCatalog(cfg);
  return {
    ok: true as const,
    catalog: cfg,
    plans,
    enabledFeatureIds: enabledProFeatureIds(cfg),
    monthPriceUsd: computeProMonthPrice(cfg),
    launchDiscountUsd: computeLaunchDiscountUsd(cfg),
  };
}

async function handler(request: Request, res?: NodeRes): Promise<Response | void> {
  const method = (request.method ?? "GET").toUpperCase();
  if (method === "OPTIONS") return respond(res, { ok: true }, 204);
  if (method !== "GET") {
    return respond(res, { ok: false, error: "method_not_allowed" }, 405);
  }
  try {
    const cfg = await getProCatalogConfig();
    return respond(res, catalogPayload(cfg), 200);
  } catch (e) {
    console.error("[pro-catalog]", e);
    return respond(res, catalogPayload(DEFAULT_PRO_CATALOG), 200);
  }
}

export default handler;
