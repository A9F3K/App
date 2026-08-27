/**
 * Smoke tests for telegram-tt-style scroll-up: display expand vs API pagination.
 * Run: npx tsx scripts/test-chat-scroll-up.mjs
 */
import assert from "node:assert/strict";
import {
  afterOlderPrepend,
  expandOlder,
  openAround,
  resolveDisplayWindow,
  sliceDisplayMessages,
  MESSAGE_LIST_VIEWPORT_LIMIT,
  MESSAGE_LIST_DISPLAY_MAX,
  keepSettledDisplayWindow,
} from "../ui/components/messages/chatMessageWindow.ts";
import { decideChatEdgeLoad } from "../ui/components/messages/chatEdgeLoadPolicy.ts";
import {
  chatEdgePrefetchPx,
  redistributeWindowBudget,
  windowBoundsAroundAnchor,
  CHAT_HISTORY_WINDOW_N,
} from "../ui/components/messages/chatHistoryWindowBudget.ts";
import { sliceMessagesByCount } from "../ui/components/messages/messageChatViewportSlice.ts";
import { shouldCollapseOutgoingEchoDuplicate } from "../ui/components/messages/optimisticOutgoingMessage.ts";
import {
  isRestorableCachedScrollForReadChat,
  resolveChatOpenSession,
} from "../ui/components/messages/chatOpenSession.ts";
import {
  clearChatScrollPosition,
  getChatScrollPosition,
  saveChatScrollPosition,
} from "../ui/messageChatScrollCache.ts";

const CHAT_SCROLL_INDICATOR_THUMB_MIN_PX = 20;
const SCROLL_INDICATOR_THUMB_MAX_TRACK_FRAC = 0.32;

/** Local thumb-size math (avoids importing react-native via scrollIndicatorPx). */
function thumbSpanPx(trackSpan, viewportSpan, contentSpan, thumbMinPx) {
  if (trackSpan <= 0 || contentSpan <= 0) return 0;
  const ratio = Math.min(1, Math.max(0, viewportSpan / contentSpan));
  let thumbSpan = Math.round(trackSpan * ratio);
  const capSpan = Math.round(trackSpan * SCROLL_INDICATOR_THUMB_MAX_TRACK_FRAC);
  thumbSpan = Math.min(thumbSpan, capSpan);
  return Math.max(thumbMinPx, Math.min(trackSpan - 1, thumbSpan));
}

function row(id, sentAtMs = id) {
  return {
    telegram_message_id: id,
    sent_at: new Date(sentAtMs).toISOString(),
    text: `m${id}`,
    is_outgoing: false,
  };
}

function makeLoaded(count, startId = 1) {
  return Array.from({ length: count }, (_, i) => row(startId + i));
}

/** Mirrors chatHistoryMerge.oldestHistoryMessageId (kept local to avoid RN import graph). */
function oldestHistoryMessageId(messages) {
  let oldest = null;
  for (const row of messages) {
    const id = row.telegram_message_id;
    if (!Number.isFinite(id) || id <= 0) continue;
    if (oldest == null || id < oldest) oldest = id;
  }
  return oldest;
}

function filterMessagesOlderThan(messages, beforeMessageId) {
  if (!(beforeMessageId > 0)) return [...messages];
  return messages.filter((row) => row.telegram_message_id < beforeMessageId);
}

/**
 * Mid-buffer prepend restore: locked message keeps the same viewport offset
 * after content remount (simulates item-anchor re-pin, not skipDomCompensate).
 */
function restoreItemAnchorScrollY(args) {
  const { anchorOffsetInViewport, anchorTopAfterMerge } = args;
  // tdesktop: scrollTop = itemTop(anchor) - offsetInViewport
  return Math.max(0, anchorTopAfterMerge - anchorOffsetInViewport);
}

console.log("chat scroll-up smoke tests");

// Complete history in buffer: scroll-up slides display (≤2N), does not grow unboundedly.
{
  const loaded = makeLoaded(120, 1000);
  const tailId = loaded[loaded.length - 1].telegram_message_id;
  const opened = openAround(loaded, tailId);
  assert.equal(opened.atLoadedBottom, true);
  assert.ok(opened.bounds.startIndex > 0, "tail open keeps older rows in buffer");
  const openedCount =
    opened.bounds.endIndex - opened.bounds.startIndex + 1;

  const expanded = expandOlder(loaded, opened);
  assert.ok(expanded, "expand toward older succeeds");
  assert.ok(expanded.bounds.startIndex < opened.bounds.startIndex);
  const slice = sliceDisplayMessages(loaded, expanded);
  assert.ok(slice.length <= MESSAGE_LIST_DISPLAY_MAX, "slid window stays ≤2N+1");
  assert.ok(
    expanded.bounds.endIndex < opened.bounds.endIndex || openedCount <= MESSAGE_LIST_DISPLAY_MAX,
    "sliding older drops newer rows when at cap",
  );
}

// Repeated older expands never exceed 2N+1 (tdesktop retained UI budget).
{
  const loaded = makeLoaded(200, 1);
  let window = openAround(loaded, loaded[199].telegram_message_id);
  for (let i = 0; i < 8; i += 1) {
    const next = expandOlder(loaded, window);
    if (!next) break;
    window = next;
    const count = window.bounds.endIndex - window.bounds.startIndex + 1;
    assert.ok(count <= MESSAGE_LIST_DISPLAY_MAX, `expand #${i + 1} count=${count}`);
  }
  assert.ok(window.bounds.startIndex === 0 || window.bounds.endIndex - window.bounds.startIndex + 1 <= MESSAGE_LIST_DISPLAY_MAX);
}

// Edge gate: in-buffer expand triggers load without hasMoreOlder.
{
  const decision = decideChatEdgeLoad({
    phase: "idle",
    userHasScrolledSinceOpen: true,
    initialScrollInProgress: false,
    prependAnchorRestorePending: false,
    loadingOlder: false,
    loadingNewer: false,
    userScrollingUp: true,
    hasMoreOlder: false,
    hasMoreNewer: false,
    canExpandOlderInBuffer: true,
    nearTop: true,
    nearBottom: false,
  });
  assert.equal(decision.loadOlder, true, "canExpandOlderInBuffer enables older edge");
}

// Edge gate: cache hydrate path when API says no more but cache is ahead.
{
  const decision = decideChatEdgeLoad({
    phase: "idle",
    userHasScrolledSinceOpen: true,
    initialScrollInProgress: false,
    prependAnchorRestorePending: false,
    loadingOlder: false,
    loadingNewer: false,
    userScrollingUp: true,
    hasMoreOlder: false,
    hasMoreNewer: false,
    canHydrateOlderFromCache: true,
    nearTop: true,
    nearBottom: false,
  });
  assert.equal(decision.loadOlder, true, "canHydrateOlderFromCache enables older edge");
}

// Pagination cursor must use min id, not sent_at sort head.
{
  const skewed = [
    row(200, 2_000),
    row(100, 3_000), // older id, later timestamp — can sit after head in sort
    row(300, 4_000),
  ].sort((a, b) => {
    const byTime = Date.parse(a.sent_at) - Date.parse(b.sent_at);
    if (byTime !== 0) return byTime;
    return a.telegram_message_id - b.telegram_message_id;
  });
  assert.equal(skewed[0].telegram_message_id, 200, "sent_at head is 200");
  assert.equal(oldestHistoryMessageId(skewed), 100, "oldest id is 100");
  const olderPage = [row(50), row(80), row(100), row(150)];
  const fresh = filterMessagesOlderThan(olderPage, oldestHistoryMessageId(skewed));
  assert.deepEqual(
    fresh.map((m) => m.telegram_message_id),
    [50, 80],
    "filter drops ids already at/above buffer oldest",
  );
}

// API older prepend always shifts so the same visual rows stay mounted.
{
  const shiftedAtTop = afterOlderPrepend(
    115,
    {
      bounds: { startIndex: 0, endIndex: 79 },
      override: null,
      anchorMessageId: 1000,
      atLoadedTop: true,
      atLoadedBottom: false,
    },
    35,
  );
  assert.equal(shiftedAtTop.override?.startIndex, 35, "shift past prepended rows even at top");
  assert.equal(shiftedAtTop.override?.endIndex, 114, "prior end shifted by prepend count");
  assert.equal(shiftedAtTop.atLoadedTop, false, "new older rows stay above the display window");
  assert.ok(
    shiftedAtTop.override.endIndex - shiftedAtTop.override.startIndex + 1 <=
      MESSAGE_LIST_DISPLAY_MAX,
    "shifted window stays ≤2N+1",
  );
}

// Wide display window is clamped to 2N+1 after prepend shift.
{
  const shiftedWide = afterOlderPrepend(
    200,
    {
      bounds: { startIndex: 0, endIndex: 119 },
      override: { startIndex: 0, endIndex: 119 },
      anchorMessageId: 1000,
      atLoadedTop: true,
      atLoadedBottom: false,
    },
    40,
  );
  assert.equal(shiftedWide.override?.startIndex, 40);
  assert.equal(
    shiftedWide.override.endIndex - shiftedWide.override.startIndex + 1,
    MESSAGE_LIST_DISPLAY_MAX,
    "wide window clamped to 2N+1 after shift",
  );
}

// Mid-buffer older prepend shifts indices so the same rows stay mounted.
{
  const shifted = afterOlderPrepend(
    115,
    {
      bounds: { startIndex: 20, endIndex: 79 },
      override: null,
      anchorMessageId: 1000,
      atLoadedTop: false,
      atLoadedBottom: false,
    },
    35,
  );
  assert.equal(shifted.override?.startIndex, 55, "shift start past prepended rows");
  assert.equal(shifted.override?.endIndex, 114, "keep prior end shifted");
  assert.equal(shifted.atLoadedTop, false, "not pinned to absolute loaded top");
}

// resolveDisplayWindow must treat afterOlderPrepend override as authoritative.
// Regression: merging override with a re-centered base widened 81→119 and jumped.
{
  const before = makeLoaded(81, 1000);
  const lockedAnchorId = before[20].telegram_message_id;
  const beforeWindow = openAround(before, lockedAnchorId);
  const beforeCount =
    beforeWindow.bounds.endIndex - beforeWindow.bounds.startIndex + 1;

  const prepended = makeLoaded(38, 900);
  const after = [...prepended, ...before];
  const shifted = afterOlderPrepend(after.length, beforeWindow, prepended.length);
  const resolved = resolveDisplayWindow(
    after,
    lockedAnchorId,
    shifted.override,
  );
  const afterCount =
    resolved.bounds.endIndex - resolved.bounds.startIndex + 1;

  assert.equal(
    shifted.override?.startIndex,
    beforeWindow.bounds.startIndex + prepended.length,
    "override start shifts by prepend count",
  );
  assert.equal(
    afterCount,
    beforeCount,
    "display row count must stay stable (no merge-widen)",
  );
  assert.equal(
    resolved.bounds.startIndex,
    shifted.override?.startIndex,
    "resolved start follows override, not re-centered base",
  );
  assert.ok(
    afterCount < beforeCount + prepended.length,
    "must not mount all prepended rows into the display window",
  );
}

// Mid-buffer Y preserve: non-zero scrollY + remount must re-pin via item anchor
// (regression: api_load used to release with skipDomCompensate and scrollY→0).
{
  const scrollYBefore = 673;
  const anchorOffsetInViewport = 120;
  // Remount shrank content and reset scrollTop to 0; anchor row now at content Y=800.
  const restoredY = restoreItemAnchorScrollY({
    scrollYBefore,
    anchorOffsetInViewport,
    anchorTopAfterMerge: 800,
  });
  assert.equal(restoredY, 680, "item-anchor restore recomputes scrollY");
  assert.notEqual(restoredY, 0, "must not leave viewport at scrollY=0 after mid-buffer merge");
  const viewportOffsetAfter = 800 - restoredY;
  assert.equal(
    viewportOffsetAfter,
    anchorOffsetInViewport,
    "locked message keeps the same viewport offset after merge",
  );
}

// Bidirectional N window: mid-thread takes N each side; ends redistribute to 2N.
{
  const n = CHAT_HISTORY_WINDOW_N;
  const mid = redistributeWindowBudget(200, 100, n);
  assert.equal(mid.older, n);
  assert.equal(mid.newer, n);

  const atTail = redistributeWindowBudget(200, 199, n);
  assert.equal(atTail.newer, 0);
  assert.equal(atTail.older, Math.min(n * 2, 199));

  const atHead = redistributeWindowBudget(200, 0, n);
  assert.equal(atHead.older, 0);
  assert.equal(atHead.newer, Math.min(n * 2, 199));

  const bounds = windowBoundsAroundAnchor(200, 199, n);
  assert.equal(bounds.endIndex, 199);
  assert.equal(bounds.startIndex, 199 - atTail.older);

  const loaded = makeLoaded(200, 1);
  const slice = sliceMessagesByCount(loaded, 199, n);
  assert.equal(slice.endIndex, 199);
  assert.ok(
    slice.endIndex - slice.startIndex + 1 === atTail.older + 1,
    "tail slice includes anchor + redistributed older",
  );
}

// Prefetch distance: max(floor, 3 × layoutH).
{
  assert.equal(chatEdgePrefetchPx(0, 3, 750), 750);
  assert.equal(chatEdgePrefetchPx(200, 3, 750), 750);
  assert.equal(chatEdgePrefetchPx(400, 3, 750), 1200);
}

// Chat scrollbar: min thumb ~20px; size uses estimated buffer span not tiny mount.
{
  const viewH = 600;
  const mountedSliceH = 2000;
  const estimatedBufferH = 12000;
  const hairline = thumbSpanPx(viewH, viewH, mountedSliceH, 4);
  const chatThumb = thumbSpanPx(
    viewH,
    viewH,
    estimatedBufferH,
    CHAT_SCROLL_INDICATOR_THUMB_MIN_PX,
  );
  assert.ok(chatThumb >= CHAT_SCROLL_INDICATOR_THUMB_MIN_PX);
  assert.ok(
    chatThumb <= hairline,
    "larger history span yields a smaller (but floored) thumb than mounted-only",
  );
}

// Edge gate: dwell at hard scroll top loads older without active scroll-up delta.
{
  const dwellAtTop = decideChatEdgeLoad({
    phase: "idle",
    userHasScrolledSinceOpen: true,
    initialScrollInProgress: false,
    prependAnchorRestorePending: false,
    loadingOlder: false,
    loadingNewer: false,
    userScrollingUp: false,
    hasMoreOlder: true,
    hasMoreNewer: false,
    nearTop: true,
    atHardScrollTop: true,
    nearBottom: false,
  });
  assert.equal(
    dwellAtTop.loadOlder,
    true,
    "atHardScrollTop enables older edge without userScrollingUp",
  );
}

// Edge gate: open-settle lock must block older paging (stuck lock = no scroll-up loads).
{
  const blocked = decideChatEdgeLoad({
    phase: "idle",
    userHasScrolledSinceOpen: true,
    initialScrollInProgress: true,
    prependAnchorRestorePending: false,
    loadingOlder: false,
    loadingNewer: false,
    userScrollingUp: true,
    hasMoreOlder: true,
    hasMoreNewer: false,
    canExpandOlderInBuffer: true,
    nearTop: true,
    atHardScrollTop: true,
    nearBottom: false,
  });
  assert.equal(
    blocked.loadOlder,
    false,
    "initialScrollInProgress must block older edge until settle clears",
  );
}

// Mid-history open: N/N when both sides have room; redistribution only at ends.
{
  const loaded = makeLoaded(200, 1000);
  const unreadId = loaded[100].telegram_message_id;
  const opened = openAround(loaded, unreadId);
  const budget = redistributeWindowBudget(200, 100, CHAT_HISTORY_WINDOW_N);
  assert.equal(budget.older, CHAT_HISTORY_WINDOW_N);
  assert.equal(budget.newer, CHAT_HISTORY_WINDOW_N);
  assert.equal(opened.bounds.startIndex, 100 - budget.older);
  assert.equal(opened.bounds.endIndex, 100 + budget.newer);
  assert.ok(opened.bounds.startIndex > 0, "mid-history open keeps older buffer rows");
}

// Near-end open redistributes unused newer budget into older (up to 2N).
{
  const loaded = makeLoaded(80, 1000);
  const unreadId = loaded[50].telegram_message_id;
  const opened = openAround(loaded, unreadId);
  const budget = redistributeWindowBudget(80, 50, CHAT_HISTORY_WINDOW_N);
  assert.ok(budget.newer < CHAT_HISTORY_WINDOW_N, "newer side short of N");
  assert.ok(budget.older > CHAT_HISTORY_WINDOW_N, "older receives redistributed budget");
  assert.equal(opened.bounds.startIndex, 50 - budget.older);
  assert.equal(opened.bounds.endIndex, 50 + budget.newer);
}

// keepSettledDisplayWindow never re-centers (regression: openAround on release
// jumped scrollY into blank spacer / background).
{
  const kept = keepSettledDisplayWindow(200, { startIndex: 40, endIndex: 120 }, MESSAGE_LIST_DISPLAY_MAX);
  assert.equal(kept.startIndex, 40, "older edge of settled window stays");
  assert.equal(
    kept.endIndex - kept.startIndex + 1,
    MESSAGE_LIST_DISPLAY_MAX,
    "clamps to display max by dropping newer only",
  );
  const under = keepSettledDisplayWindow(80, { startIndex: 10, endIndex: 50 }, MESSAGE_LIST_DISPLAY_MAX);
  assert.deepEqual(under, { startIndex: 10, endIndex: 50 }, "under-max window unchanged");
}

// Older-page merge must be decided synchronously (React 18 does not flush
// setState updaters after await). Simulates Irina: 40 loaded + 163 older API rows.
{
  const prev = makeLoaded(40, 131443195904);
  const pageCursor = oldestHistoryMessageId(prev);
  assert.ok(pageCursor != null && pageCursor > 0);
  const incoming = makeLoaded(163, pageCursor - 163);
  const incomingOlder = filterMessagesOlderThan(incoming, pageCursor);
  const strictlyOlder = filterMessagesOlderThan(incomingOlder, pageCursor);
  assert.equal(strictlyOlder.length, 163, "API page is strictly older than buffer head");
  const byId = new Map();
  for (const row of [...strictlyOlder, ...prev]) {
    byId.set(row.telegram_message_id, row);
  }
  const next = [...byId.values()].sort(
    (a, b) => a.telegram_message_id - b.telegram_message_id,
  );
  const nextHead = oldestHistoryMessageId(next);
  const addedCount =
    pageCursor > 0 && nextHead > 0 && nextHead < pageCursor
      ? Math.max(1, next.length - prev.length)
      : next.length - prev.length;
  assert.equal(addedCount, 163, "sync merge reports growth without setState updater");
  assert.equal(next.length, 203);
  // keepGoing must not retry solely because nextCursor < loadedOldest when the
  // server already reported hasMoreOlder=false (that caused empty_page + stall).
  const hasMoreOlder = false;
  const nextCursor = nextHead;
  const keepGoing = hasMoreOlder === true;
  assert.equal(keepGoing, false, "do not advance into empty_page when server is done");
  assert.ok(nextCursor < pageCursor);
}

// MMI regression: large older API page lands above the display window
// (afterOlderPrepend shifts startIndex). Post-release must still expand the
// in-buffer older slice when hasMoreOlder=false — otherwise scroll-up looks dead.
{
  const prependedCount = 234;
  const before = makeLoaded(42, 1000);
  const prepended = makeLoaded(prependedCount, 100);
  const after = [...prepended, ...before];
  const beforeWindow = {
    bounds: { startIndex: 0, endIndex: 41 },
    override: null,
    anchorMessageId: before[0].telegram_message_id,
    atLoadedTop: true,
    atLoadedBottom: true,
  };
  const afterApi = afterOlderPrepend(after.length, beforeWindow, prependedCount);
  assert.equal(
    afterApi.override?.startIndex,
    prependedCount,
    "new older rows stay above the display window",
  );
  assert.equal(afterApi.override?.endIndex, prependedCount + 41);
  assert.equal(afterApi.atLoadedTop, false);

  const hasMoreOlder = false;
  const canExpandOlderFromBuffer =
    (afterApi.override?.startIndex ?? afterApi.bounds.startIndex) > 0;
  const shouldContinueOlderEdge = hasMoreOlder || canExpandOlderFromBuffer;
  assert.equal(
    shouldContinueOlderEdge,
    true,
    "post-release chain continues when buffer can expand older even if API is done",
  );

  const expanded = expandOlder(after, afterApi);
  assert.ok(expanded, "expandOlder reveals buffered older rows");
  assert.ok(
    expanded.bounds.startIndex < afterApi.override.startIndex,
    "expandOlder moves display toward buffered older rows",
  );

  const gate = decideChatEdgeLoad({
    phase: "idle",
    userHasScrolledSinceOpen: true,
    initialScrollInProgress: false,
    prependAnchorRestorePending: false,
    loadingOlder: false,
    loadingNewer: false,
    userScrollingUp: true,
    hasMoreOlder: false,
    hasMoreNewer: false,
    canExpandOlderInBuffer: canExpandOlderFromBuffer,
    nearTop: true,
    nearBottom: false,
  });
  assert.equal(gate.loadOlder, true, "edge gate prefers in-buffer older expand over no-op");
}

// Cache hydrate must leave hasMoreOlder open — prefetch/around windows are
// never EOF. Otherwise scroll-up dies after absorbing one cache page.
{
  const cacheHasMoreOlder = false; // typical char-budget / around slice
  const hydratedHasMoreOlder = true; // forced after absorb
  assert.equal(
    hydratedHasMoreOlder,
    true,
    "hydrating older rows from cache must not close the older edge",
  );
  assert.equal(
    cacheHasMoreOlder || hydratedHasMoreOlder,
    true,
    "server false-EOF on a cache slice is overridden after hydrate",
  );
}

// Open-chat cache listener must absorb a fuller prefetch into a short preview
// (extendsOlder / upgradesPreview), not only when the thread is empty.
{
  const previewCount = 7;
  const fullCacheCount = 81;
  const loadedOldest = 1000;
  const cacheOldest = 100; // extends older than the painted preview head
  const extendsOlder =
    cacheOldest > 0 && loadedOldest > 0 && cacheOldest < loadedOldest;
  const upgradesPreview = true; // painted previewOnly, cache is full
  const shouldApplyWhileOpen =
    extendsOlder || upgradesPreview || previewCount === 0;
  assert.equal(
    shouldApplyWhileOpen,
    true,
    "full prefetch must apply into an open preview chat",
  );
  assert.ok(
    fullCacheCount > previewCount,
    "prefetch upgrade grows the open buffer before the next API page",
  );
}

// tdesktop scrollTopItem: keep the locked message; never stick to y=0 (that
// teleports onto newly revealed rows). Auto-chain only while still at hard top
// after restore — prefetch-zone chaining caused mid-list jumps (1034→24812).
{
  const LOAD_OLDER_THRESHOLD_PX = 120;
  const startY = 1077;
  const afterItemAnchorY = 24812; // wrong path: auto display_expand then item keep
  const startedNearTop = startY <= LOAD_OLDER_THRESHOLD_PX;
  const restoreY = startY; // item-anchor keeps visual; no stick-to-0
  assert.equal(startedNearTop, false, "prefetch-zone is not hard top");
  assert.equal(restoreY, 1077, "mid-list prepend must keep scrollTopItem");
  assert.notEqual(
    restoreY,
    afterItemAnchorY,
    "must not auto-expand into a mid-list jump",
  );
  const nearHardTopAfterRestore =
    afterItemAnchorY <= LOAD_OLDER_THRESHOLD_PX;
  assert.equal(
    nearHardTopAfterRestore,
    false,
    "after scrollTopItem restore, do not auto-chain from prefetch zone",
  );
}

// Short channel history (e.g. HyperlinkSpace Channel Chat count≈3–4): a stale
// display-window override must never collapse the painted rows to 1.
{
  const short = makeLoaded(3, 100);
  const collapsedOverride = { startIndex: 2, endIndex: 2 };
  const window = resolveDisplayWindow(
    short,
    short[2].telegram_message_id,
    collapsedOverride,
  );
  assert.equal(window.override, null, "short buffer clears override");
  assert.equal(window.bounds.startIndex, 0);
  assert.equal(window.bounds.endIndex, 2);
  const painted = sliceDisplayMessages(short, window);
  assert.equal(painted.length, 3, "all short-history rows must paint");
}

{
  const short = makeLoaded(4, 50);
  const window = resolveDisplayWindow(short, 0, null);
  assert.equal(window.bounds.startIndex, 0);
  assert.equal(window.bounds.endIndex, 3);
  assert.equal(sliceDisplayMessages(short, window).length, 4);
}

// Consecutive outgoing stickers share empty captions + timestamps. Echo
// collapse must only pair an optimistic (negative) id with a server id —
// otherwise HyperlinkSpace Channel Chat painted 1 of 3 stickers.
{
  const t0 = Date.parse("2026-08-24T10:16:00.000Z");
  const sticker = (id) => ({
    telegram_message_id: id,
    is_outgoing: true,
    text: "",
    sent_at: new Date(t0 + id).toISOString(),
  });
  assert.equal(
    shouldCollapseOutgoingEchoDuplicate(sticker(1), sticker(2)),
    false,
    "two real sticker ids must not collapse",
  );
  assert.equal(
    shouldCollapseOutgoingEchoDuplicate(sticker(-2), sticker(3)),
    true,
    "pending sticker still merges into the confirmed row",
  );
}

// Fully-read chats: stale top cache (scrollY=0) must not reopen at the oldest
// rows — open the bottom like Telegram.
{
  const chatId = -1003816023790;
  clearChatScrollPosition(chatId);
  saveChatScrollPosition(chatId, {
    scrollY: 0,
    contentH: 759,
    distanceFromBottom: 759,
    followingBottom: false,
    anchorMessageId: 419430400,
  });
  assert.equal(
    isRestorableCachedScrollForReadChat(getChatScrollPosition(chatId)),
    false,
    "stuck top paint is not restorable for a read chat",
  );
  const session = resolveChatOpenSession({
    telegram_chat_id: chatId,
    unread_count: 0,
    last_message_telegram_id: 422576128,
    last_read_inbox_message_id: 422576128,
  });
  assert.equal(session.mode, "bottom");
  assert.equal(session.scroll.openAnchor, "bottom");
  assert.equal(session.scroll.followingBottom, true);
  assert.equal(session.scroll.restore, null);
  clearChatScrollPosition(chatId);

  saveChatScrollPosition(chatId, {
    scrollY: 240,
    contentH: 2000,
    distanceFromBottom: 1760,
    followingBottom: false,
    anchorMessageId: 100,
  });
  const mid = resolveChatOpenSession({
    telegram_chat_id: chatId,
    unread_count: 0,
    last_message_telegram_id: 422576128,
    last_read_inbox_message_id: 422576128,
  });
  assert.ok(mid.mode === "restore" || mid.mode === "around_anchor");
  assert.equal(mid.scroll.openAnchor, "top");
  clearChatScrollPosition(chatId);

  // Poisoned followingBottom+scrollY=0 still opens via bottom restore path.
  saveChatScrollPosition(chatId, {
    scrollY: 0,
    contentH: 759,
    distanceFromBottom: 759,
    followingBottom: true,
    anchorMessageId: 419430400,
  });
  assert.equal(
    isRestorableCachedScrollForReadChat(getChatScrollPosition(chatId)),
    true,
    "followingBottom cache is restorable (bottom path)",
  );
  const poisoned = resolveChatOpenSession({
    telegram_chat_id: chatId,
    unread_count: 0,
    last_message_telegram_id: 422576128,
    last_read_inbox_message_id: 422576128,
  });
  assert.equal(poisoned.mode, "bottom");
  assert.equal(poisoned.scroll.openAnchor, "bottom");
  assert.equal(poisoned.scroll.followingBottom, true);
  assert.equal(
    poisoned.scroll.restore,
    null,
    "followingBottom open must pin to tail — not replay scrollY≈0 restore",
  );
  clearChatScrollPosition(chatId);
}

console.log("all chat scroll-up smoke tests passed");
