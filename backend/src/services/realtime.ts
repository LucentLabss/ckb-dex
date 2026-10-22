// Broadcasts projection snapshots and updates to WebSocket subscribers by market or maker channel.
import type { IncomingMessage, Server as HttpServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";

import OrderModel from "../models/order.js";
import TradeModel from "../models/trade.js";

export type RealtimeChannel =
  | `market:${string}:orderbook`
  | `market:${string}:trades`
  | `maker:${string}:orders`;

interface RealtimeMessage {
  type: "snapshot" | "update";
  channel: RealtimeChannel;
  sequence: number;
  data: unknown;
}

/** Limits that keep one client, or many, from exhausting memory, sockets or the database. */
export interface RealtimeLimits {
  /** Largest inbound frame accepted, in bytes. */
  maxPayloadBytes: number;
  maxConnections: number;
  maxConnectionsPerIp: number;
  maxChannelsPerMessage: number;
  maxChannelsPerSocket: number;
  /** Rows per snapshot; snapshots are a bounded view, the REST API pages the rest. */
  snapshotLimit: number;
  /** Close a socket whose unsent data exceeds this, since it is not keeping up. */
  maxBufferedBytes: number;
  heartbeatMs: number;
}

export const DEFAULT_REALTIME_LIMITS: RealtimeLimits = {
  maxPayloadBytes: 4 * 1024,
  maxConnections: 1_000,
  maxConnectionsPerIp: 20,
  maxChannelsPerMessage: 8,
  maxChannelsPerSocket: 16,
  snapshotLimit: 100,
  maxBufferedBytes: 1024 * 1024,
  heartbeatMs: 30_000,
};

const HASH = "0x[0-9a-fA-F]{64}";
const CHANNEL_PATTERN = new RegExp(`^(?:market:${HASH}:(?:orderbook|trades)|maker:${HASH}:orders)$`);

export const isValidChannel = (value: unknown): value is RealtimeChannel =>
  typeof value === "string" && value.length <= 100 && CHANNEL_PATTERN.test(value);

export class RealtimeBroadcaster {
  private static instance: RealtimeBroadcaster | undefined;
  private wss: WebSocketServer | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private sequenceByChannel = new Map<string, number>();
  private subscriptions = new Map<string, Set<WebSocket>>();
  private channelsBySocket = new Map<WebSocket, Set<string>>();
  private connectionsByIp = new Map<string, number>();
  private limits: RealtimeLimits = DEFAULT_REALTIME_LIMITS;

  public static getInstance(): RealtimeBroadcaster {
    if (RealtimeBroadcaster.instance === undefined) {
      RealtimeBroadcaster.instance = new RealtimeBroadcaster();
    }

    return RealtimeBroadcaster.instance;
  }

  public attach(server: HttpServer, limits: Partial<RealtimeLimits> = {}): void {
    if (this.wss !== undefined) {
      return;
    }

    this.limits = { ...DEFAULT_REALTIME_LIMITS, ...limits };
    this.wss = new WebSocketServer({ server, maxPayload: this.limits.maxPayloadBytes });

    this.wss.on("connection", (socket: WebSocket, request: IncomingMessage) => {
      const ip = request.socket.remoteAddress ?? "unknown";
      const perIp = this.connectionsByIp.get(ip) ?? 0;
      if (this.channelsBySocket.size >= this.limits.maxConnections || perIp >= this.limits.maxConnectionsPerIp) {
        socket.close(1013, "Too many connections");
        return;
      }
      this.connectionsByIp.set(ip, perIp + 1);
      this.channelsBySocket.set(socket, new Set());

      let alive = true;
      socket.on("pong", () => { alive = true; });
      (socket as WebSocket & { isAliveCheck?: () => boolean }).isAliveCheck = () => {
        const wasAlive = alive;
        alive = false;
        return wasAlive;
      };

      socket.on("message", async (raw: Buffer | ArrayBuffer | Buffer[]) => {
        try {
          const message = JSON.parse(raw.toString());
          const channels: unknown = message?.channels;

          if (!Array.isArray(channels) || channels.length === 0) {
            this.sendError(socket, "Expected channels array");
            return;
          }
          if (channels.length > this.limits.maxChannelsPerMessage) {
            this.sendError(socket, `At most ${this.limits.maxChannelsPerMessage} channels per message`);
            return;
          }
          const invalid = channels.find((channel) => !isValidChannel(channel));
          if (invalid !== undefined) {
            this.sendError(socket, "Invalid channel name");
            return;
          }

          const owned = this.channelsBySocket.get(socket);
          if (owned === undefined) return; // closed while parsing
          const fresh = (channels as string[]).filter((channel) => !owned.has(channel));
          if (owned.size + new Set(fresh).size > this.limits.maxChannelsPerSocket) {
            this.sendError(socket, `At most ${this.limits.maxChannelsPerSocket} channels per connection`);
            return;
          }

          for (const channel of new Set(channels as string[])) {
            owned.add(channel);
            if (!this.subscriptions.has(channel)) {
              this.subscriptions.set(channel, new Set());
            }

            this.subscriptions.get(channel)?.add(socket);
            const snapshot = await this.getSnapshot(channel);
            this.sendToSocket(socket, {
              type: "snapshot",
              channel: channel as RealtimeChannel,
              sequence: this.nextSequence(channel),
              data: snapshot,
            });
          }
        } catch (error) {
          this.sendError(socket, error instanceof SyntaxError ? "Invalid websocket payload" : "Unable to process message");
        }
      });

      socket.on("close", () => this.release(socket, ip));
      socket.on("error", () => socket.terminate());
    });

    // Drop peers that stopped answering pings so dead sockets don't accumulate.
    this.heartbeat = setInterval(() => {
      for (const socket of this.channelsBySocket.keys()) {
        const check = (socket as WebSocket & { isAliveCheck?: () => boolean }).isAliveCheck;
        if (check && !check()) {
          socket.terminate();
          continue;
        }
        socket.ping();
      }
    }, this.limits.heartbeatMs);
    this.heartbeat.unref();
  }

  public async close(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    const wss = this.wss;
    this.wss = undefined;
    if (!wss) return;
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }

  public async emit(channel: RealtimeChannel): Promise<void> {
    const subscribers = this.subscriptions.get(channel);
    if (subscribers === undefined || subscribers.size === 0) {
      return; // nobody is listening: skip the snapshot query entirely
    }

    const snapshot = await this.getSnapshot(channel);
    const message: RealtimeMessage = {
      type: "update",
      channel,
      sequence: this.nextSequence(channel),
      data: snapshot,
    };

    for (const socket of subscribers) {
      this.sendToSocket(socket, message);
    }
  }

  public async emitOrderbook(xudtTypeHash: string): Promise<void> {
    await this.emit(`market:${xudtTypeHash}:orderbook` as RealtimeChannel);
  }

  public async emitTrades(xudtTypeHash: string): Promise<void> {
    await this.emit(`market:${xudtTypeHash}:trades` as RealtimeChannel);
  }

  public async emitMakerOrders(makerLockHash: string): Promise<void> {
    await this.emit(`maker:${makerLockHash}:orders` as RealtimeChannel);
  }

  private release(socket: WebSocket, ip: string): void {
    for (const channel of this.channelsBySocket.get(socket) ?? []) {
      const subscribers = this.subscriptions.get(channel);
      subscribers?.delete(socket);
      if (subscribers?.size === 0) {
        this.subscriptions.delete(channel);
        this.sequenceByChannel.delete(channel); // nobody left to observe a sequence gap
      }
    }
    this.channelsBySocket.delete(socket);

    const remaining = (this.connectionsByIp.get(ip) ?? 1) - 1;
    if (remaining <= 0) this.connectionsByIp.delete(ip);
    else this.connectionsByIp.set(ip, remaining);
  }

  private nextSequence(channel: string): number {
    const current = this.sequenceByChannel.get(channel) ?? 0;
    const next = current + 1;
    this.sequenceByChannel.set(channel, next);
    return next;
  }

  private sendError(socket: WebSocket, message: string): void {
    if (socket.readyState === 1) {
      socket.send(JSON.stringify({ type: "error", message }));
    }
  }

  private sendToSocket(socket: WebSocket, message: RealtimeMessage): void {
    if (socket.readyState !== 1) return;
    if (socket.bufferedAmount > this.limits.maxBufferedBytes) {
      socket.terminate(); // a client that cannot keep up must not pin server memory
      return;
    }
    socket.send(JSON.stringify(message));
  }

  private async getSnapshot(channel: string): Promise<unknown> {
    const limit = this.limits.snapshotLimit;

    if (channel.startsWith("market:") && channel.endsWith(":orderbook")) {
      const xudtTypeHash = channel.slice("market:".length, -":orderbook".length);
      // Best prices on each side: asks ascending, bids descending (price-time priority).
      const side = (direction: "ASK" | "BID", price: 1 | -1) =>
        OrderModel.find({ xudtTypeHash, status: "LIVE", direction })
          .sort({ priceValue: price, blockNum: 1, txIdx: 1, _id: 1 })
          .limit(limit)
          .select({ priceValue: 0, blockNum: 0, txIdx: 0 })
          .lean();
      const [asks, bids] = await Promise.all([side("ASK", 1), side("BID", -1)]);
      return [...asks, ...bids];
    }

    if (channel.startsWith("market:") && channel.endsWith(":trades")) {
      const xudtTypeHash = channel.slice("market:".length, -":trades".length);
      return TradeModel.find({ xudtTypeHash, status: { $ne: "REVERTED" } })
        .sort({ blockNum: -1, _id: 1 })
        .limit(limit)
        .select({ blockNum: 0 })
        .lean();
    }

    if (channel.startsWith("maker:") && channel.endsWith(":orders")) {
      const ownerLockHash = channel.slice("maker:".length, -":orders".length);
      return OrderModel.find({ ownerLockHash })
        .sort({ createdAt: -1, _id: 1 })
        .limit(limit)
        .select({ priceValue: 0, blockNum: 0, txIdx: 0 })
        .lean();
    }

    return [];
  }
}
