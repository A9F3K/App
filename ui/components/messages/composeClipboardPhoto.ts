export type ComposePendingPhoto = {
  /** Object URL for preview / optimistic bubble. */
  previewUri: string;
  /** Raw base64 (no data: prefix). */
  base64: string;
  mime: string;
  width: number | null;
  height: number | null;
};

/** Read the first image item from a browser ClipboardEvent. */
export async function readClipboardImageFromPasteEvent(
  event: { clipboardData?: DataTransfer | null },
): Promise<ComposePendingPhoto | null> {
  const data = event.clipboardData;
  if (!data) return null;

  const files = Array.from(data.files ?? []);
  const fromFiles = files.find((file) => file.type.startsWith("image/"));
  if (fromFiles) {
    return fileToPendingPhoto(fromFiles);
  }

  const items = Array.from(data.items ?? []);
  for (const item of items) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (!file) continue;
    return fileToPendingPhoto(file);
  }
  return null;
}

async function fileToPendingPhoto(file: File): Promise<ComposePendingPhoto | null> {
  const mime = file.type || "image/jpeg";
  if (!mime.startsWith("image/")) return null;
  if (file.size <= 0 || file.size > 8 * 1024 * 1024) return null;

  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  const base64 = btoa(binary);
  const previewUri = URL.createObjectURL(file);
  const dims = await measureImageUri(previewUri);
  return {
    previewUri,
    base64,
    mime,
    width: dims?.width ?? null,
    height: dims?.height ?? null,
  };
}

function measureImageUri(
  uri: string,
): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    if (typeof Image === "undefined") {
      resolve(null);
      return;
    }
    const img = new Image();
    img.onload = () => {
      resolve({
        width: Math.max(1, Math.round(img.naturalWidth || img.width || 1)),
        height: Math.max(1, Math.round(img.naturalHeight || img.height || 1)),
      });
    };
    img.onerror = () => resolve(null);
    img.src = uri;
  });
}

export function revokeComposePendingPhoto(photo: ComposePendingPhoto | null | undefined): void {
  if (!photo?.previewUri) return;
  if (photo.previewUri.startsWith("blob:")) {
    try {
      URL.revokeObjectURL(photo.previewUri);
    } catch {
      /* ignore */
    }
  }
}
