import { WS_URL } from "../../config/env.js";

/**
 * Shared WebSocket to the backend RealtimeBroadcaster (src/services/realtime.ts).
 * Channels: `market:<xudtTypeHash>:orderbook`, `market:<xudtTypeHash>:trades`,
 * `maker:<lockHash>:orders`. Each subscription first receives a snapshot, then
 * a full snapshot again on every update. Reconnects with backoff and
 * resubscribes; the backend has no unsubscribe, so leaving is client-side only.
 */
const listeners = new Map(); // channel -> Set<fn>
let socket = null;
let retry = 0;
let reconnectTimer = null;

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
