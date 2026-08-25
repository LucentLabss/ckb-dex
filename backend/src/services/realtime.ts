// Broadcasts projection snapshots and updates to WebSocket subscribers by market or maker channel.
import type { Server as HttpServer } from "node:http";
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

export class RealtimeBroadcaster {
  private static instance: RealtimeBroadcaster | undefined;
  private wss: WebSocketServer | undefined;
  private sequenceByChannel = new Map<string, number>();
  private subscriptions = new Map<string, Set<WebSocket>>();

  public static getInstance(): RealtimeBroadcaster {
    if (RealtimeBroadcaster.instance === undefined) {
      RealtimeBroadcaster.instance = new RealtimeBroadcaster();
    }

    return RealtimeBroadcaster.instance;
  }

  public attach(server: HttpServer): void {
    if (this.wss !== undefined) {
      return;
    }

    this.wss = new WebSocketServer({ server });

    this.wss.on("connection", (socket: WebSocket) => {
      socket.on("message", async (raw: Buffer | ArrayBuffer | Buffer[]) => {
        try {
          const message = JSON.parse(raw.toString());
          const channels = Array.isArray(message?.channels) ? message.channels : [];

          if (!Array.isArray(channels) || channels.length === 0) {
            socket.send(JSON.stringify({ type: "error", message: "Expected channels array" }));
            return;
          }

          for (const channel of channels) {
            if (!this.subscriptions.has(channel)) {
              this.subscriptions.set(channel, new Set());
            }

            this.subscriptions.get(channel)?.add(socket);
            const snapshot = await this.getSnapshot(channel);
            this.sendToSocket(socket, {
              type: "snapshot",
              channel,
              sequence: this.nextSequence(channel),
              data: snapshot,
            });
          }
        } catch (error) {
          socket.send(
            JSON.stringify({
              type: "error",
              message: error instanceof Error ? error.message : "Invalid websocket payload",
            }),
          );
        }
      });

      socket.on("close", () => {
        for (const subscribers of this.subscriptions.values()) {
          subscribers.delete(socket);
        }
      });
    });
  }

  public async emit(channel: RealtimeChannel): Promise<void> {
    const snapshot = await this.getSnapshot(channel);
    const message: RealtimeMessage = {
      type: "update",
      channel,
      sequence: this.nextSequence(channel),
      data: snapshot,
    };

    const subscribers = this.subscriptions.get(channel);
    if (subscribers === undefined || subscribers.size === 0) {
      return;
    }

    for (const socket of subscribers) {
      if (socket.readyState === 1) {
        socket.send(JSON.stringify(message));
      }
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

  private nextSequence(channel: string): number {
    const current = this.sequenceByChannel.get(channel) ?? 0;
    const next = current + 1;
    this.sequenceByChannel.set(channel, next);
    return next;
  }

  private sendToSocket(socket: WebSocket, message: RealtimeMessage): void {
    if (socket.readyState === 1) {
      socket.send(JSON.stringify(message));
    }
  }

  private async getSnapshot(channel: string): Promise<unknown> {
    if (channel.startsWith("market:") && channel.endsWith(":orderbook")) {
      const xudtTypeHash = channel.slice("market:".length, -":orderbook".length);
      return OrderModel.find({ xudtTypeHash, status: "LIVE" })
        .sort({ totalAskCapacity: 1, createdAt: 1, outPoint: 1 })
        .lean();
    }

    if (channel.startsWith("market:") && channel.endsWith(":trades")) {
      const xudtTypeHash = channel.slice("market:".length, -":trades".length);
      return TradeModel.find({ xudtTypeHash }).sort({ confirmedAtBlock: -1, createdAt: -1 }).lean();
    }

    if (channel.startsWith("maker:" ) && channel.endsWith(":orders")) {
      const makerLockHash = channel.slice("maker:".length, -":orders".length);
      return OrderModel.find({ makerLockHash }).sort({ createdAt: -1, _id: -1 }).lean();
    }

    return [];
  }
}
