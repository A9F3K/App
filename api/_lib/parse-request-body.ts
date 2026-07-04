type AnyRequest = Request | {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  url?: string;
  body?: unknown;
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
};

/** Parse JSON POST bodies across Web `Request` and Vercel Node adapters. */
export async function parseRequestJsonBody<T extends Record<string, unknown> = Record<string, unknown>>(
  request: AnyRequest,
): Promise<T> {
  const raw = request as {
    body?: unknown;
    json?: () => Promise<unknown>;
    text?: () => Promise<string>;
  };
  if (raw.body !== undefined && raw.body !== null) {
    if (typeof raw.body === "object" && !Buffer.isBuffer(raw.body)) {
      return raw.body as T;
    }
    if (typeof raw.body === "string" && raw.body.trim()) {
      try {
        return JSON.parse(raw.body) as T;
      } catch {
        return {} as T;
      }
    }
  }
  if (typeof raw.json === "function") {
    try {
      const parsed = await raw.json();
      return (parsed && typeof parsed === "object" ? parsed : {}) as T;
    } catch {
      /* fall through */
    }
  }
  if (typeof raw.text === "function") {
    try {
      const text = await raw.text();
      return (text ? JSON.parse(text) : {}) as T;
    } catch {
      return {} as T;
    }
  }
  return {} as T;
}
