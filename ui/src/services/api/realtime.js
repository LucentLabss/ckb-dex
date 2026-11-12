import { WS_URL } from "../../config/env.js";

/**
 * Shared WebSocket to the backend RealtimeBroadcaster (src/services/realtime.ts).
 * Channels: `market:<xudtTypeHash>:orderbook`, `market:<xudtTypeHash>:trades`,
 * `maker:<lockHash>:orders`. Each subscription first receives a snapshot, then
 * a full snapshot again on every update. Reconnects with backoff and
 * resubscribes; the backend has no unsubscribe, so leaving is client-side only.
 *
 * Mobile browsers freeze background tabs and often drop the socket without
 * firing `close` (screen lock, app switch, Wi-Fi <-> cellular). So when the
 * page returns to the foreground or the network comes back, we open a fresh
 * connection, which re-sends every channel's snapshot and catches up on
 * anything missed (e.g. an order that settled while the phone was locked).
 */
const listeners = new Map(); // channel -> Set<fn>
let socket = null;
let retry = 0;
let reconnectTimer = null;
let hiddenAt = null;
/** Reconnect on return if the page was in the background at least this long. */
const STALE_AFTER_HIDDEN_MS = 3_000;

function send(channels) {
  if (socket?.readyState === WebSocket.OPEN && channels.length) {
    socket.send(JSON.stringify({ channels }));
  }
}

function connect() {
  clearTimeout(reconnectTimer);
  socket = new WebSocket(WS_URL);

  socket.onopen = () => {
    retry = 0;
    send([...listeners.keys()]);
  };
  socket.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.type === "error") return console.error("[LucentDex] Realtime server error:", msg.message, msg);
    listeners.get(msg.channel)?.forEach((fn) => fn(msg.data, msg.type));
  };
  socket.onclose = (event) => {
    socket = null;
    if (!listeners.size) return;
    const delay = Math.min(30_000, 1000 * 2 ** retry++);
    console.warn(
      `[LucentDex] Realtime connection to ${WS_URL} closed (code ${event.code}); retrying in ${delay / 1000}s`
    );
    reconnectTimer = setTimeout(connect, delay);
  };
}

/** Drops the current socket (if any) and connects again straight away. */
function reconnectNow() {
  if (!listeners.size) return;
  clearTimeout(reconnectTimer);
  retry = 0;
  if (socket) {
    socket.onclose = null;
    socket.onmessage = null;
    socket.close();
    socket = null;
  }
  connect();
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      hiddenAt = Date.now();
      return;
    }
    const away = hiddenAt === null ? 0 : Date.now() - hiddenAt;
    hiddenAt = null;
    if (away >= STALE_AFTER_HIDDEN_MS || socket?.readyState !== WebSocket.OPEN) reconnectNow();
  });
  // Restored from the back/forward cache: the old socket is gone.
  window.addEventListener("pageshow", (e) => e.persisted && reconnectNow());
  window.addEventListener("online", reconnectNow);
}

export function subscribe(channel, onData) {
  if (!listeners.has(channel)) listeners.set(channel, new Set());
  const set = listeners.get(channel);
  const isNew = set.size === 0;
  set.add(onData);

  if (!socket) connect();
  else if (isNew) send([channel]);

  return () => {
    set.delete(onData);
    if (!set.size) listeners.delete(channel);
    if (!listeners.size && socket) {
      socket.onclose = null;
      socket.close();
      socket = null;
    }
  };
}
