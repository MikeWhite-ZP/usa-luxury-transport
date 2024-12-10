import { WebSocket as WS, WebSocketServer } from "ws";
import { db } from "../db";
import { locationTracking, bookings } from "@db/schema";
import { eq } from "drizzle-orm";

// Message type definitions
type MessageType = 'init' | 'subscribe_tracking' | 'location_update' | 'ping' | 'pong' | 'error' | 'connection_established' | 'init_success' | 'subscribe_success';

interface BaseMessage {
  type: MessageType;
}

interface LocationUpdate extends BaseMessage {
  type: 'location_update';
  bookingId: number;
  latitude: number;
  longitude: number;
  speed?: number;
  heading?: number;
}

interface InitMessage extends BaseMessage {
  type: 'init';
  userId: number;
  role: string;
}

interface SubscribeMessage extends BaseMessage {
  type: 'subscribe_tracking';
  bookingId: number;
}

interface PingMessage extends BaseMessage {
  type: 'ping';
}

interface ErrorMessage extends BaseMessage {
  type: 'error';
  message: string;
}

interface TrackingClient {
  ws: WS;
  bookingId?: number;
  userId: number;
  role: string;
  lastPing?: number;
}

type IncomingMessage = LocationUpdate | InitMessage | SubscribeMessage | PingMessage;
type OutgoingMessage = LocationUpdate | ErrorMessage | BaseMessage;

const clients = new Map<WS, TrackingClient>();

export function setupWebSocket(wss: WebSocketServer) {
  function handleClose(ws: WS) {
    clients.delete(ws);
    console.log("Client disconnected");
  }

  function handleError(ws: WS, error: Error) {
    console.error("WebSocket error:", error);
    if (ws.readyState === WS.OPEN) {
      try {
        ws.send(JSON.stringify({ type: "error", message: error.message || "Internal server error" }));
      } catch (e) {
        console.error("Failed to send error message:", e);
      }
    }
  }

  async function handleMessage(ws: WS, message: Buffer) {
    let data: IncomingMessage;
    
    try {
      data = JSON.parse(message.toString('utf-8'));
    } catch (e) {
      handleError(ws, new Error("Invalid JSON message"));
      return;
    }

    if (!data.type) {
      handleError(ws, new Error("Message type is required"));
      return;
    }

    const client = clients.get(ws);
    if (!client && data.type !== 'init') {
      handleError(ws, new Error("Client not initialized"));
      return;
    }

    try {
      switch (data.type) {
        case "init": {
          const initData = data as InitMessage;
          if (!initData.userId || !initData.role) {
            throw new Error("userId and role are required for initialization");
          }
          clients.set(ws, { 
            ws, 
            userId: initData.userId, 
            role: initData.role,
            lastPing: Date.now()
          });
          ws.send(JSON.stringify({ type: 'init_success' }));
          break;
        }

        case "subscribe_tracking": {
          const subData = data as SubscribeMessage;
          if (!subData.bookingId) {
            throw new Error("bookingId is required for tracking subscription");
          }
          if (client) {
            client.bookingId = subData.bookingId;
            client.lastPing = Date.now();
            ws.send(JSON.stringify({ type: 'subscribe_success', bookingId: subData.bookingId }));
          }
          break;
        }

        case "location_update": {
          const locationData = data as LocationUpdate;
          if (!locationData.bookingId || !locationData.latitude || !locationData.longitude) {
            throw new Error("Invalid location update data");
          }

          if (client) {
            client.lastPing = Date.now();
          }

          await db.insert(locationTracking).values({
            bookingId: locationData.bookingId,
            latitude: locationData.latitude.toString(),
            longitude: locationData.longitude.toString(),
            speed: locationData.speed?.toString(),
            heading: locationData.heading?.toString(),
            status: 'active'
          });

          await db.update(bookings)
            .set({
              lastKnownLatitude: locationData.latitude.toString(),
              lastKnownLongitude: locationData.longitude.toString(),
              lastLocationUpdate: new Date(),
            })
            .where(eq(bookings.id, locationData.bookingId));

          broadcastLocationUpdate(locationData);
          break;
        }

        case "ping": {
          if (client) {
            client.lastPing = Date.now();
            ws.send(JSON.stringify({ type: 'pong' }));
          }
          break;
        }

        default:
          throw new Error(`Unknown message type: ${(data as any).type}`);
      }
    } catch (error) {
      handleError(ws, error instanceof Error ? error : new Error(String(error)));
    }
  }

  wss.on("connection", (ws: WS) => {
    console.log("New WebSocket connection established");
    
    if (ws.readyState === WS.OPEN) {
      try {
        ws.send(JSON.stringify({ type: 'connection_established' }));
      } catch (e) {
        console.error("Failed to send connection acknowledgment:", e);
      }
    }

    ws.on("message", (message) => handleMessage(ws, message as Buffer));
    ws.on("error", (error) => handleError(ws, error));
    ws.on("close", () => handleClose(ws));
  });

  // Ping all clients every 30 seconds to keep connections alive
  const PING_INTERVAL = 30000;
  const PING_TIMEOUT = 70000; // Consider connection dead if no ping for 70 seconds

  setInterval(() => {
    const now = Date.now();
    const clientsArray = Array.from(clients.entries());
    
    for (const [ws, client] of clientsArray) {
      // Check if client hasn't responded to ping for too long
      if (client.lastPing && now - client.lastPing > PING_TIMEOUT) {
        console.log(`Client ${client.userId} timed out, closing connection`);
        ws.close();
        clients.delete(ws);
        continue;
      }

      // Send ping to active connections
      if (ws.readyState === WS.OPEN) {
        try {
          ws.ping();
        } catch (e) {
          console.error("Ping failed:", e);
          clients.delete(ws);
        }
      }
    }
  }, PING_INTERVAL);
}

function broadcastLocationUpdate(update: LocationUpdate) {
  const message = JSON.stringify({
    type: "location_update",
    data: update
  });

  const clientsArray = Array.from(clients.entries());
  for (const [ws, client] of clientsArray) {
    if (client.bookingId === update.bookingId && ws.readyState === WS.OPEN) {
      try {
        ws.send(message);
      } catch (error) {
        console.error("Failed to broadcast location update:", error);
        clients.delete(ws);
      }
    }
  }
}

// Helper function to clean up stale connections
function cleanupStaleConnections() {
  const now = Date.now();
  const STALE_TIMEOUT = 120000; // 2 minutes

  const clientsArray = Array.from(clients.entries());
  for (const [ws, client] of clientsArray) {
    if (
      ws.readyState === WS.CLOSED || 
      ws.readyState === WS.CLOSING ||
      (client.lastPing && now - client.lastPing > STALE_TIMEOUT)
    ) {
      clients.delete(ws);
      console.log("Cleaned up stale connection for user:", client.userId);
    }
  }
}

// Run cleanup every minute
setInterval(cleanupStaleConnections, 60000);
