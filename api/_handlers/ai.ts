/**
 * AI gateway.
 * - GET /api/ai  → health check ({ ok: true, ai: true }).
 * - POST /api/ai → AI response from providers (currently OpenAI).
 *
 * Supports both:
 * - Web API style (Request → Response)
 * - Legacy Node style (req, res)
 */

import { transmit, type AiRequest } from "../../ai/transmitter.js";
import { getTinyModelStatus } from "../../ai/tinymodel.js";
import { parseRequestJsonBody } from "../_lib/parse-request-body.js";

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

async function handler(
  request: Request,
  res?: NodeRes,
): Promise<Response | void> {
  const method = (request as any)?.method ?? "GET";

  if (method === "GET") {
    const tinymodel = await getTinyModelStatus();
    const body = { ok: true, ai: true, tinymodel };

    if (res) {
      res.setHeader("Content-Type", "application/json");
      res.status(200);
      res.end(JSON.stringify(body));
      return;
    }

    return jsonResponse(body, 200);
  }

  if (method !== "POST") {
    const body = { ok: false, error: "Method not allowed" };

    if (res) {
      res.setHeader("Content-Type", "application/json");
      res.status(405);
      res.end(JSON.stringify(body));
      return;
    }

    return jsonResponse(body, 405);
  }

  let payload: unknown;
  try {
    payload = await parseRequestJsonBody(request);
  } catch {
    const body = { ok: false, error: "Invalid JSON body" };

    if (res) {
      res.setHeader("Content-Type", "application/json");
      res.status(400);
      res.end(JSON.stringify(body));
      return;
    }

    return jsonResponse(body, 400);
  }

  const { input, mode, userId, context } = (payload || {}) as Partial<AiRequest>;

  if (typeof input !== "string" || input.trim().length === 0) {
    const body = { ok: false, error: "Field 'input' (string) is required." };

    if (res) {
      res.setHeader("Content-Type", "application/json");
      res.status(400);
      res.end(JSON.stringify(body));
      return;
    }

    return jsonResponse(body, 400);
  }

  const result = await transmit({
    input,
    mode,
    userId,
    context,
  });

  const status = result.ok ? 200 : 500;

  if (res) {
    res.setHeader("Content-Type", "application/json");
    res.status(status);
    res.end(JSON.stringify(result));
    return;
  }

  return jsonResponse(result, status);
}

export default handler;
export const GET = handler;
export const POST = handler;

