// figma-slides broker — the daemon that owns :3055.
//
// It is deliberately dumb: it knows nothing about slides, never interprets a
// command and never picks a target. It keeps a registry of connections and
// forwards addressed envelopes. All selection intelligence lives in the MCP
// server, which is what lets ambiguity travel up to the agent instead of being
// guessed at down here.

import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { DEFAULT_BROKER_PORT, PROTOCOL_VERSION, type TargetInfo } from "./protocol";

export interface BrokerOptions {
  port?: number;
  pingIntervalMs?: number;
  maxMissedPongs?: number;
  idleShutdownMs?: number;
  identifyGraceMs?: number;
  onIdleShutdown?: () => void;
}

export interface BrokerHandle {
  port: number;
  close(): Promise<void>;
}

interface PluginConn {
  connId: string;
  ws: WebSocket;
  docName: string;
  editorType: string;
}

interface Route {
  controllerId: string;
  target: string;
  replyId: string;
}

export function startBroker(options: BrokerOptions = {}): Promise<BrokerHandle> {
  const port = options.port ?? DEFAULT_BROKER_PORT;
  const pingIntervalMs = options.pingIntervalMs ?? 20_000;
  const maxMissedPongs = options.maxMissedPongs ?? 2;
  const idleShutdownMs = options.idleShutdownMs ?? 30 * 60_000;
  const identifyGraceMs = options.identifyGraceMs ?? 5_000;
  const onIdleShutdown = options.onIdleShutdown ?? (() => process.exit(0));

  const plugins = new Map<string, PluginConn>();
  const controllers = new Map<string, WebSocket>();
  const routes = new Map<string, Route>();
  const missedPongs = new WeakMap<WebSocket, number>();
  // Sockets that are up but never said hello. A pre-2.0 plugin sits here
  // forever: it answers pings at the protocol level, so the reaper never
  // touches it, and it would otherwise be completely invisible.
  const unidentified = new Set<WebSocket>();
  let lastActive = Date.now();
  let wireCounter = 0;

  function send(ws: WebSocket, msg: unknown): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  function targetList(): TargetInfo[] {
    return [...plugins.values()].map((p) => ({
      connId: p.connId,
      docName: p.docName,
      editorType: p.editorType,
    }));
  }

  function targetsMessage() {
    return { type: "targets", targets: targetList(), unidentified: unidentified.size };
  }

  function broadcastTargets(): void {
    const msg = targetsMessage();
    for (const ws of controllers.values()) send(ws, msg);
  }

  const wss = new WebSocketServer({ port });

  wss.on("connection", (ws) => {
    missedPongs.set(ws, 0);
    lastActive = Date.now();
    let identity: { role: "plugin" | "controller"; connId: string } | null = null;

    const graceTimer = setTimeout(() => {
      if (identity) return;
      unidentified.add(ws);
      broadcastTargets();
    }, identifyGraceMs);
    graceTimer.unref?.();

    ws.on("pong", () => missedPongs.set(ws, 0));
    ws.on("error", () => {
      // 'close' always follows; nothing useful to do with the error itself.
    });

    ws.on("message", (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object") return;

      if (msg.type === "hello") {
        if (identity) return;
        if (msg.protocol !== PROTOCOL_VERSION) {
          send(ws, { type: "error", code: "protocol_mismatch", brokerProtocol: PROTOCOL_VERSION });
          ws.close();
          return;
        }
        clearTimeout(graceTimer);
        const connId = randomUUID();
        if (msg.role === "plugin") {
          identity = { role: "plugin", connId };
          plugins.set(connId, {
            connId,
            ws,
            docName: typeof msg.docName === "string" && msg.docName ? msg.docName : "Untitled",
            editorType: typeof msg.editorType === "string" ? msg.editorType : "unknown",
          });
          broadcastTargets();
        } else if (msg.role === "controller") {
          identity = { role: "controller", connId };
          controllers.set(connId, ws);
          send(ws, targetsMessage());
        } else {
          ws.close();
        }
        return;
      }

      if (!identity) return;

      if (identity.role === "controller" && msg.type === "command") {
        if (typeof msg.id !== "string") return;
        const plugin = plugins.get(msg.target);
        if (!plugin) {
          send(ws, {
            type: "error",
            id: msg.id,
            code: "no_such_target",
            error: `No connected deck with id "${msg.target}".`,
          });
          return;
        }
        // Two controllers pick request ids independently, so ids can collide on
        // the wire. Rename on collision and map back on the way out.
        const wireId = routes.has(msg.id) ? `${msg.id}~${++wireCounter}` : msg.id;
        routes.set(wireId, { controllerId: identity.connId, target: msg.target, replyId: msg.id });
        send(plugin.ws, { id: wireId, command: msg.command, params: msg.params ?? {} });
        return;
      }

      if (identity.role === "plugin" && typeof msg.id === "string") {
        const route = routes.get(msg.id);
        if (!route || route.target !== identity.connId) return;
        routes.delete(msg.id);
        const controller = controllers.get(route.controllerId);
        if (!controller) return;
        send(controller, {
          type: "response",
          id: route.replyId,
          success: msg.success !== false,
          data: msg.data,
          error: msg.error,
        });
      }
    });

    ws.on("close", () => {
      clearTimeout(graceTimer);
      if (!identity) {
        if (unidentified.delete(ws)) broadcastTargets();
        return;
      }
      if (identity.role === "plugin") {
        plugins.delete(identity.connId);
        // Reject only this target's in-flight work. A second deck's commands
        // keep flying.
        for (const [wireId, route] of [...routes]) {
          if (route.target !== identity.connId) continue;
          routes.delete(wireId);
          const controller = controllers.get(route.controllerId);
          if (controller) {
            send(controller, {
              type: "error",
              id: route.replyId,
              code: "target_disconnected",
              error: "The Figma plugin for this deck disconnected before answering.",
            });
          }
        }
        broadcastTargets();
      } else {
        controllers.delete(identity.connId);
        for (const [wireId, route] of [...routes]) {
          if (route.controllerId === identity.connId) routes.delete(wireId);
        }
      }
    });
  });

  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      const missed = missedPongs.get(ws) ?? 0;
      if (missed >= maxMissedPongs) {
        ws.terminate();
        continue;
      }
      missedPongs.set(ws, missed + 1);
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }
    if (plugins.size > 0 || controllers.size > 0) {
      lastActive = Date.now();
    } else if (Date.now() - lastActive >= idleShutdownMs) {
      onIdleShutdown();
    }
  }, pingIntervalMs);
  timer.unref?.();

  function close(): Promise<void> {
    clearInterval(timer);
    return new Promise((resolve) => {
      for (const ws of wss.clients) ws.terminate();
      wss.close(() => resolve());
    });
  }

  return new Promise((resolve, reject) => {
    wss.once("listening", () => {
      const addr = wss.address();
      wss.on("error", (err) => console.error(`[figma-slides-broker] ${err.message}`));
      resolve({ port: typeof addr === "object" && addr ? addr.port : port, close });
    });
    wss.once("error", (err) => {
      clearInterval(timer);
      reject(err);
    });
  });
}

// Auto-start only when this bundle is the process entry point. Tests import
// startBroker() from the same file and must not get a listening socket.
if (path.basename(process.argv[1] ?? "") === "broker.mjs") {
  const envPort = Number(process.env.FIGMA_SLIDES_BROKER_PORT);
  startBroker({ port: Number.isFinite(envPort) && envPort > 0 ? envPort : DEFAULT_BROKER_PORT }).then(
    (handle) => {
      console.error(`[figma-slides-broker] listening on ws://localhost:${handle.port}`);
    },
    (err: NodeJS.ErrnoException) => {
      // Losing the race for the port is the expected outcome when two MCP
      // servers start together: another broker won and is already serving.
      if (err.code === "EADDRINUSE") process.exit(0);
      console.error(`[figma-slides-broker] Fatal: ${err.message}`);
      process.exit(1);
    }
  );
}
