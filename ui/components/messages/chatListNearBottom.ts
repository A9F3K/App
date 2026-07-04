/** Scroll-column near-bottom → chat list expansion / server paging (see HomeAuthenticatedScreen). */
let handler: (() => void) | null = null;

export function setChatListNearBottomHandler(next: (() => void) | null): void {
  handler = next;
}

export function invokeChatListNearBottom(): void {
  handler?.();
}
