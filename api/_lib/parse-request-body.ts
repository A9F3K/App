type AnyRequest = Request | {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  url?: string;
  body?: unknown;
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
};

function isReadableStreamLike(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { getReader?: unknown }).getReader === "function"
  );
}

/** True when Vercel/Node already parsed the POST body into a plain object. */
function isPreParsedJsonObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  if (Buffer.isBuffer(value)) return false;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return false;
  if (isReadableStreamLike(value)) return false;
  if (typeof Blob !== "undefined" && value instanceof Blob) return false;
  return true;
}

function parseJsonText(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Parse JSON POST bodies across Web `Request` and Vercel Node adapters. */
export async function parseRequestJsonBody<T extends Record<string, unknown> = Record<string, unknown>>(
  request: AnyRequest,
): Promise<T> {
  const raw = request as {
    body?: unknown;
    json?: () => Promise<unknown>;
    text?: () => Promise<string>;
  };

  // Node/Vercel often pre-parses into `req.body` and leaves the stream unusable.
  if (raw.body !== undefined && raw.body !== null) {
    if (isPreParsedJsonObject(raw.body)) {
      return raw.body as T;
    }
    if (typeof raw.body === "string") {
      return parseJsonText(raw.body) as T;
    }
    if (Buffer.isBuffer(raw.body)) {
      return parseJsonText(raw.body.toString("utf8")) as T;
    }
  }

  if (typeof raw.json === "function") {
    try {
      const parsed = await raw.json();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as T;
      }
      return {} as T;
    } catch {
      /* fall through — body may still be readable via text() */
    }
  }

  if (typeof raw.text === "function") {
    try {
      return parseJsonText(await raw.text()) as T;
    } catch {
      return {} as T;
    }
  }

  return {} as T;
}
