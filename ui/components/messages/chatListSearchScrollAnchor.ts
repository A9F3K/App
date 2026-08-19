/** Scroll the left column to the bottom when chat-list search results update. */
let handler: (() => void) | null = null;

export function setChatListSearchScrollToEndHandler(next: (() => void) | null): void {
  handler = next;
}

export function invokeChatListSearchScrollToEnd(): void {
  handler?.();
}
