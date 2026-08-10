/**
 * `/api/wallet/register` and `/api/wallet/status` — Vercel does not route multi-segment
 * paths to `api/[...path].ts` at the project root, so this dynamic segment file is required.
 */

import registerHandler from '../_handlers/wallet-register.js';
import statusHandler from '../_handlers/wallet-status.js';
import envelopeVerifyHandler from '../_handlers/wallet-envelope-verify.js';

type NodeRes = {
  setHeader(name: string, value: string): void;
  status(code: number): void;
  end(body?: string): void;
};

const HANDLERS: Record<string, typeof registerHandler> = {
  register: registerHandler,
  status: statusHandler,
  'envelope-verify': envelopeVerifyHandler,
};

function pathnameFromRequest(request: Request): string {
  const raw = request.url ?? '';
  if (raw.startsWith('/')) {
    return raw.split('?')[0] ?? '';
  }
  if (raw.startsWith('http')) {
    try {
      return new URL(raw).pathname;
    } catch {
      return '';
    }
  }
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? 'localhost';
  const proto = request.headers.get('x-forwarded-proto') ?? 'https';
  try {
    return new URL(raw || '/', `${proto}://${host}`).pathname;
  } catch {
    return '';
  }
}

async function router(
  request: Request,
  res?: NodeRes,
): Promise<Response | void> {
  const pathname = pathnameFromRequest(request);
  const match = pathname.match(/^\/api\/wallet\/([^/?]+)/i);
  const segment = match?.[1]?.trim() ?? '';
  const handler = HANDLERS[segment];
  if (!handler) {
    const body = JSON.stringify({
      ok: false,
      error: 'not_found',
      path: `wallet/${segment || '(empty)'}`,
      hint: 'Use /api/wallet/register, /api/wallet/status, or /api/wallet/envelope-verify',
    });
    if (res) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.status(404);
      res.end(body);
      return;
    }
    return new Response(body, {
      status: 404,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }
  const result = await handler(request);
  // Handlers return a Web Response. When Vercel also passes a Node `res`,
  // leaving it open hangs until FUNCTION_INVOCATION_TIMEOUT.
  if (res && result instanceof Response) {
    const text = await result.text();
    const contentType =
      result.headers.get('content-type') ?? 'application/json; charset=utf-8';
    res.setHeader('Content-Type', contentType);
    res.status(result.status);
    res.end(text);
    return;
  }
  return result;
}

export default router;
export const GET = router;
export const POST = router;
export const OPTIONS = router;
