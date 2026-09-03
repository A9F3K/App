/**
 * GET /api/ton-account-holdings?address=<friendly-or-raw>
 * Proxies TonAPI account + jettons + TON/USD rate using server-side TONAPI_KEY.
 */

const TONAPI_BASE = "https://tonapi.io/v2";
const JSON_HEADERS = { "Content-Type": "application/json" };

type NodeRes = {
  setHeader(name: string, value: string): void;
  status(code: number): void;
  end(body?: string): void;
};

function jsonResponse(body: object, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function tonapiHeaders(): HeadersInit {
  const token = (process.env.TONAPI_KEY || process.env.EXPO_PUBLIC_TONAPI_KEY || "").trim();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function fromNanoTon(nano: string | number): number {
  try {
    const n = typeof nano === "string" ? BigInt(nano) : BigInt(Math.trunc(nano));
    return Number(n) / 1e9;
  } catch {
    return 0;
  }
}

function readUsdPrice(prices: Record<string, number> | undefined): number | null {
  if (!prices) return null;
  const usd = prices.USD ?? prices.usd;
  return typeof usd === "number" && Number.isFinite(usd) && usd > 0 ? usd : null;
}

async function fetchHoldings(address: string) {
  const headers = tonapiHeaders();
  const accountUrl = `${TONAPI_BASE}/accounts/${encodeURIComponent(address)}`;
  const jettonsUrl = `${TONAPI_BASE}/accounts/${encodeURIComponent(address)}/jettons?currencies=usd`;
  const ratesUrl = `${TONAPI_BASE}/rates?tokens=ton&currencies=usd`;

  const [accountRes, jettonsRes, ratesRes] = await Promise.all([
    fetch(accountUrl, { headers }),
    fetch(jettonsUrl, { headers }),
    fetch(ratesUrl, { headers }),
  ]);

  if (!accountRes.ok) {
    const text = await accountRes.text().catch(() => "");
    throw new Error(`tonapi_account_${accountRes.status}:${text.slice(0, 120)}`);
  }

  const account = (await accountRes.json()) as {
    address?: string;
    balance?: number | string;
    status?: string;
  };
  const nativeNano = String(account.balance ?? 0);

  let tonPriceUsd: number | null = null;
  if (ratesRes.ok) {
    try {
      const rates = (await ratesRes.json()) as {
        rates?: Record<string, { prices?: Record<string, number> }>;
      };
      tonPriceUsd = readUsdPrice(rates.rates?.TON?.prices ?? rates.rates?.ton?.prices);
    } catch {
      tonPriceUsd = null;
    }
  }

  const jettons: Array<{
    balance: string;
    jetton: {
      address: string;
      name?: string;
      symbol?: string;
      decimals?: number;
      image?: string;
      verification?: string;
    };
    priceUsd: number | null;
  }> = [];

  if (jettonsRes.ok) {
    const data = (await jettonsRes.json()) as {
      balances?: Array<{
        balance?: string | number;
        price?: { prices?: Record<string, number> };
        jetton?: {
          address?: string;
          name?: string;
          symbol?: string;
          decimals?: number;
          image?: string;
          verification?: string;
        };
      }>;
    };
    for (const row of data.balances ?? []) {
      const jetton = row.jetton;
      const jettonAddress = jetton?.address?.trim();
      const symbol = jetton?.symbol?.trim();
      if (!jettonAddress || !symbol) continue;
      const balanceRaw = String(row.balance ?? "0");
      try {
        if (BigInt(balanceRaw) <= 0n) continue;
      } catch {
        continue;
      }
      jettons.push({
        balance: balanceRaw,
        jetton: {
          address: jettonAddress,
          name: jetton?.name,
          symbol,
          decimals: typeof jetton?.decimals === "number" ? jetton.decimals : 9,
          image: jetton?.image,
          verification: jetton?.verification,
        },
        priceUsd: readUsdPrice(row.price?.prices),
      });
    }
  }

  return {
    ok: true,
    address: account.address ?? address,
    status: account.status ?? null,
    nativeBalance: fromNanoTon(nativeNano),
    nativeBalanceNano: nativeNano,
    tonPriceUsd,
    jettons,
  };
}

async function handler(request: Request, res?: NodeRes): Promise<Response | void> {
  const method = (request as { method?: string }).method ?? "GET";
  if (method !== "GET") {
    const body = { ok: false, error: "method_not_allowed" };
    if (res) {
      res.setHeader("Content-Type", "application/json");
      res.status(405);
      res.end(JSON.stringify(body));
      return;
    }
    return jsonResponse(body, 405);
  }

  let address = "";
  try {
    // Vercel Node often passes a relative `request.url` (e.g. `/api/...?address=`).
    const rawUrl = (request as { url?: string }).url ?? "";
    address = new URL(rawUrl, "http://localhost").searchParams.get("address")?.trim() ?? "";
  } catch {
    address = "";
  }

  if (!address) {
    const body = { ok: false, error: "address_required" };
    if (res) {
      res.setHeader("Content-Type", "application/json");
      res.status(400);
      res.end(JSON.stringify(body));
      return;
    }
    return jsonResponse(body, 400);
  }

  try {
    const holdings = await fetchHoldings(address);
    if (res) {
      res.setHeader("Content-Type", "application/json");
      res.status(200);
      res.end(JSON.stringify(holdings));
      return;
    }
    return jsonResponse(holdings, 200);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const body = { ok: false, error: message };
    if (res) {
      res.setHeader("Content-Type", "application/json");
      res.status(502);
      res.end(JSON.stringify(body));
      return;
    }
    return jsonResponse(body, 502);
  }
}

export default handler;
export const GET = handler;
