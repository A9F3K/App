const ALLOWED_HOSTS = new Set(["tokens.swap.coffee", "backend.swap.coffee", "api.swap.coffee"]);

function isAllowedSwapCoffeeUrl(raw) {
  try {
    const u = new URL(String(raw || "").trim());
    if (u.protocol !== "https:") return false;
    return ALLOWED_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

/**
 * Desktop renderer fetch to Swap.Coffee is flaky (CORS + DDoS-Guard). Main-process net.fetch
 * bypasses renderer CORS and is more reliable from the Electron shell.
 */
function registerSwapCoffeeFetchIpc({ ipcMain, net, log }) {
  ipcMain.handle("hsp-swap-coffee-fetch", async (_event, payload) => {
    const url = payload?.url;
    if (!isAllowedSwapCoffeeUrl(url)) {
      return { ok: false, error: "blocked url" };
    }

    const timeoutMs = Math.min(Math.max(Number(payload?.timeoutMs) || 45_000, 5_000), 120_000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await net.fetch(url, {
        method: payload?.method || "GET",
        headers: payload?.headers || {},
        body: payload?.body,
        signal: controller.signal,
      });
      const body = await res.text();
      return { ok: true, status: res.status, body };
    } catch (e) {
      const msg =
        e?.name === "AbortError"
          ? `Swap.Coffee request timed out after ${timeoutMs}ms`
          : e?.message || String(e);
      try {
        log(`[swap-coffee-fetch] ${url} ${msg}`);
      } catch (_) {}
      return { ok: false, error: msg };
    } finally {
      clearTimeout(timer);
    }
  });
}

/** Patch page-world fetch before the Expo bundle runs (works without rebuilding dist). */
const SWAP_COFFEE_FETCH_SHIM = `(function(){try{var d=window.__HSP_DESKTOP__;if(!d||typeof d.fetchSwapCoffee!=="function"||window.__HSP_SWAP_COFFEE_FETCH_SHIM__)return;window.__HSP_SWAP_COFFEE_FETCH_SHIM__=true;function plainHeaders(h){var out={Accept:"application/json"};if(!h)return out;if(typeof Headers!=="undefined"&&h instanceof Headers){h.forEach(function(v,k){out[k]=v});return out}if(typeof h==="object"){for(var k in h){if(Object.prototype.hasOwnProperty.call(h,k))out[k]=h[k]}}return out}var nativeFetch=fetch.bind(globalThis);globalThis.fetch=function(input,init){var url=typeof input==="string"?input:(input instanceof URL?input.href:(input&&input.url?input.url:String(input)));if(url&&/https:\\/\\/(tokens|backend|api)\\.swap\\.coffee\\//.test(url)){return d.fetchSwapCoffee(url,{method:(init&&init.method)||"GET",headers:plainHeaders(init&&init.headers),body:init&&typeof init.body==="string"?init.body:void 0,timeoutMs:45000}).then(function(result){if(!result||!result.ok)throw new Error(result&&result.error?result.error:"Swap.Coffee fetch failed");return new Response(result.body||"",{status:result.status||200,headers:{"Content-Type":"application/json"}})})}return nativeFetch(input,init)};console.log("[hsp] swap.coffee fetch shim installed")}catch(e){console.error("[hsp] swap.coffee fetch shim failed",e)}})();`;

function installSwapCoffeeRendererFetchShim(webContents, log) {
  if (!webContents || webContents.isDestroyed()) return;
  const inject = () => {
    if (webContents.isDestroyed()) return;
    webContents
      .executeJavaScript(SWAP_COFFEE_FETCH_SHIM, true)
      .catch((e) => {
        try {
          log(`[swap-coffee-fetch] shim inject failed: ${e?.message || e}`);
        } catch (_) {}
      });
  };
  webContents.on("dom-ready", inject);
  webContents.on("did-finish-load", inject);
}

module.exports = { registerSwapCoffeeFetchIpc, installSwapCoffeeRendererFetchShim };
