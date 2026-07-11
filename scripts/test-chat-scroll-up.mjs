/**
 * Smoke tests for telegram-tt-style scroll-up: display expand vs API pagination.
 * Run: npx tsx scripts/test-chat-scroll-up.mjs
 */
import assert from "node:assert/strict";
import {
  expandOlder,
  openAround,
  sliceDisplayMessages,
} from "../ui/components/messages/chatMessageWindow.ts";
import { decideChatEdgeLoad } from "../ui/components/messages/chatEdgeLoadPolicy.ts";

function row(id) {
  return {
    telegram_message_id: id,
    sent_at: new Date(id).toISOString(),
    text: `m${id}`,
    is_outgoing: false,
  };
}

function makeLoaded(count, startId = 1) {
  return Array.from({ length: count }, (_, i) => row(startId + i));
}

console.log("chat scroll-up smoke tests");

// Complete history in buffer: scroll-up expands display before API.
{
  const loaded = makeLoaded(120, 1000);
  const tailId = loaded[loaded.length - 1].telegram_message_id;
  const opened = openAround(loaded, tailId);
  assert.equal(opened.atLoadedBottom, true);
  assert.ok(opened.bounds.startIndex > 0, "tail open keeps older rows in buffer");

  const expanded = expandOlder(loaded, opened);
  assert.ok(expanded, "expand toward older succeeds");
  assert.ok(expanded.bounds.startIndex < opened.bounds.startIndex);
  const slice = sliceDisplayMessages(loaded, expanded);
  assert.ok(slice.length > 40, "expanded slice shows more than one page");
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

console.log("all chat scroll-up smoke tests passed");
