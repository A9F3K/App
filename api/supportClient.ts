import { buildApiUrl } from "./_base";

export type SupportMessageDto = {
  id: string;
  thread_id: string;
  role: "user" | "staff";
  content: string;
  created_at: string;
};

export type SupportThreadDto = {
  id: string;
  username: string;
  created_at: string;
  updated_at: string;
  unread_for_staff?: boolean;
  last_preview?: string | null;
};

async function parseJson<T>(res: Response): Promise<T & { ok?: boolean; error?: string }> {
  try {
    return (await res.json()) as T & { ok?: boolean; error?: string };
  } catch {
    return { ok: false, error: `Invalid response (${res.status})` } as T & {
      ok?: boolean;
      error?: string;
    };
  }
}

export async function fetchMySupportChat(): Promise<{
  ok: boolean;
  thread?: SupportThreadDto;
  messages?: SupportMessageDto[];
  error?: string;
}> {
  const res = await fetch(buildApiUrl("/api/support"), {
    method: "GET",
    credentials: "include",
  });
  return parseJson(res);
}

export async function sendSupportUserMessage(content: string): Promise<{
  ok: boolean;
  message?: SupportMessageDto;
  error?: string;
}> {
  const res = await fetch(buildApiUrl("/api/support"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ action: "send", content }),
  });
  return parseJson(res);
}

export async function fetchStaffSupportThreads(): Promise<{
  ok: boolean;
  threads?: SupportThreadDto[];
  error?: string;
}> {
  const res = await fetch(buildApiUrl("/api/support?staff=1"), {
    method: "GET",
    credentials: "include",
  });
  return parseJson(res);
}

export async function fetchStaffSupportThread(threadId: string): Promise<{
  ok: boolean;
  thread?: SupportThreadDto;
  messages?: SupportMessageDto[];
  error?: string;
}> {
  const res = await fetch(
    buildApiUrl(`/api/support?staff=1&threadId=${encodeURIComponent(threadId)}`),
    {
      method: "GET",
      credentials: "include",
    },
  );
  return parseJson(res);
}

export async function sendStaffSupportReply(
  threadId: string,
  content: string,
): Promise<{ ok: boolean; message?: SupportMessageDto; error?: string }> {
  const res = await fetch(buildApiUrl("/api/support"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ action: "staff_reply", threadId, content }),
  });
  return parseJson(res);
}
