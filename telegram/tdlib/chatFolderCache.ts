/** Chat folder IDs from TDLib `updateChatFolders` (no getChatFolders API). */

const folderIdsByUser = new Map<string, number[]>();

export function setChatFolderIds(telegramUsername: string, folderIds: number[]): void {
  const next = [
    ...new Set(
      folderIds.filter((id) => Number.isFinite(id) && id > 0).map((id) => Math.trunc(id)),
    ),
  ].sort((a, b) => a - b);
  folderIdsByUser.set(telegramUsername, next);
}

export function getChatFolderIds(telegramUsername: string): number[] {
  return folderIdsByUser.get(telegramUsername) ?? [];
}

export function ingestChatFoldersUpdate(
  telegramUsername: string,
  update: { chat_folders?: Array<{ id?: number }> },
): number[] {
  const ids = (update.chat_folders ?? [])
    .map((row) => row.id)
    .filter((id): id is number => typeof id === "number" && Number.isFinite(id) && id > 0);
  setChatFolderIds(telegramUsername, ids);
  return getChatFolderIds(telegramUsername);
}

export function clearChatFolderIds(telegramUsername: string): void {
  folderIdsByUser.delete(telegramUsername);
}
