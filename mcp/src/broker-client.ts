// Controller side of the bridge. Connects to the broker, starts one if none is
// running, and keeps reconnecting with backoff. Losing the broker is a normal,
// recoverable event — it must never take the MCP process down with it.

import { WebSocket } from "ws";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { DEFAULT_BROKER_PORT, PROTOCOL_VERSION, type TargetInfo } from "./protocol";

const COMMAND_TIMEOUT_MS = 15_000;
const RECONNECT_MIN_MS = 250;
const RECONNECT_MAX_MS = 5_000;
const SPAWN_COOLDOWN_MS = 3_000;

export interface BrokerClientOptions {
  port?: number;
  autoSpawn?: boolean;
  commandTimeoutMs?: number;
  log?: (msg: string) => void;
}

interface Pending {
  target: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class BrokerClient {
  readonly port: number;
  protocolError: string | null = null;

  private readonly autoSpawn: boolean;
  private readonly commandTimeoutMs: number;
  private readonly log: (msg: string) => void;

  private ws: WebSocket | null = null;
  private connected = false;
  private targets: TargetInfo[] = [];
  private pending = new Map<string, Pending>();
  private reconnectDelay = RECONNECT_MIN_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSpawnAt = 0;
  private closed = false;
  private readonly idPrefix = randomUUID().slice(0, 8);
  private idCounter = 0;

  constructor(options: BrokerClientOptions = {}) {
    this.port = options.port ?? DEFAULT_BROKER_PORT;
    this.autoSpawn = options.autoSpawn ?? true;
    this.commandTimeoutMs = options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS;
    this.log = options.log ?? (() => {});
  }

  start(): void {
    if (this.closed) return;
    this.connect();
  }

  getTargets(): TargetInfo[] {
    return this.targets;
  }

  async ready(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!this.connected && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return this.connected;
  }

  /**
   * Why the bridge is not usable right now, phrased for a human. Only
   * meaningful once `ready()` has already returned false.
   */
  connectionHint(): string {
    if (this.protocolError) return this.protocolError;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      // Something is listening and completed a WebSocket handshake but never
      // answered the hello — almost always a pre-broker figma-slides-mcp, which
      // owned this port itself.
      return (
        `Something on port ${this.port} accepted the connection but never identified as a ` +
        `figma-slides broker — most likely an older figma-slides-mcp still holding the port. ` +
        `Stop it with \`lsof -ti :${this.port} | xargs kill\` and retry.`
      );
    }
    return `Not connected to the figma-slides broker on ws://localhost:${this.port} yet. It is starting up — retry in a moment.`;
  }

  async send(
    target: string,
    command: string,
    params: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<unknown> {
    if (this.protocolError) throw new Error(this.protocolError);
    const timeout = timeoutMs ?? this.commandTimeoutMs;
    if (!(await this.ready(timeout))) throw new Error(this.connectionHint());

    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error(this.connectionHint());
    }

    const id = `req_${this.idPrefix}_${++this.idCounter}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Command '${command}' timed out after ${timeout / 1000}s`));
      }, timeout);
      this.pending.set(id, { target, resolve, reject, timer });
      ws.send(JSON.stringify({ type: "command", id, target, command, params }));
    });
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.ws?.close();
    this.ws = null;
    this.connected = false;
    this.rejectAll("The MCP server is shutting down");
  }

  private connect(): void {
    if (this.closed) return;
    const ws = new WebSocket(`ws://localhost:${this.port}`);
    this.ws = ws;

    ws.on("open", () => {
      this.reconnectDelay = RECONNECT_MIN_MS;
      this.protocolError = null;
      ws.send(JSON.stringify({ type: "hello", role: "controller", protocol: PROTOCOL_VERSION }));
      this.log(`connected to broker on ws://localhost:${this.port}`);
    });

    ws.on("message", (raw) => this.handleMessage(raw.toString()));

    ws.on("error", () => {
      // 'close' follows and owns the reconnect.
    });

    ws.on("close", () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.connected = false;
      this.targets = [];
      this.rejectAll("Lost the connection to the figma-slides broker");
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.maybeSpawnBroker();
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private maybeSpawnBroker(): void {
    if (!this.autoSpawn) return;
    const now = Date.now();
    if (now - this.lastSpawnAt < SPAWN_COOLDOWN_MS) return;
    this.lastSpawnAt = now;

    const brokerPath = fileURLToPath(new URL("./broker.mjs", import.meta.url));
    try {
      const child = spawn(process.execPath, [brokerPath], {
        detached: true,
        stdio: "ignore",
      });
      child.on("error", () => {});
      child.unref();
      this.log(`starting broker daemon (${brokerPath})`);
    } catch {
      // The next reconnect tick tries again.
    }
  }

  private handleMessage(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "targets" && Array.isArray(msg.targets)) {
      this.targets = msg.targets;
      this.connected = true;
      return;
    }

    if (msg.type === "response" && typeof msg.id === "string") {
      const pending = this.take(msg.id);
      if (!pending) return;
      if (msg.success) pending.resolve(msg.data);
      else pending.reject(new Error(msg.error || "Unknown plugin error"));
      return;
    }

    if (msg.type === "error") {
      if (msg.code === "protocol_mismatch") {
        this.protocolError =
          `The broker on port ${this.port} speaks protocol ${msg.brokerProtocol ?? "?"}, ` +
          `this MCP server speaks ${PROTOCOL_VERSION}. An older figma-slides-mcp is still running — ` +
          `stop it with \`lsof -ti :${this.port} | xargs kill\` and retry.`;
        this.log(this.protocolError);
        this.rejectAll(this.protocolError);
        return;
      }
      if (typeof msg.id === "string") {
        const pending = this.take(msg.id);
        if (pending) pending.reject(new Error(msg.error || msg.code));
      }
    }
  }

  private take(id: string): Pending | undefined {
    const pending = this.pending.get(id);
    if (!pending) return undefined;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    return pending;
  }

  private rejectAll(reason: string): void {
    for (const [id, pending] of [...this.pending]) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(new Error(reason));
    }
  }
}
