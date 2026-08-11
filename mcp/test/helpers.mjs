import net from "node:net";
import { WebSocket } from "ws";
import { PROTOCOL_VERSION } from "../dist/protocol-constants.mjs";

export const PROTOCOL = PROTOCOL_VERSION;

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

export function connectRaw(port, opts = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`, opts);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

export function send(ws, msg) {
  ws.send(JSON.stringify(msg));
}

export function nextMessage(ws, predicate = () => true, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error("timed out waiting for a matching message"));
    }, timeoutMs);
    function onMessage(raw) {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!predicate(msg)) return;
      clearTimeout(timer);
      ws.off("message", onMessage);
      resolve(msg);
    }
    ws.on("message", onMessage);
  });
}

export function collect(ws, predicate = () => true) {
  const seen = [];
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (predicate(msg)) seen.push(msg);
  });
  return seen;
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function helloPlugin(port, docName, editorType = "slides", opts = {}) {
  const ws = await connectRaw(port, opts);
  send(ws, { type: "hello", role: "plugin", protocol: PROTOCOL, docName, editorType });
  return ws;
}

export async function helloController(port) {
  const ws = await connectRaw(port);
  const first = nextMessage(ws, (m) => m.type === "targets");
  send(ws, { type: "hello", role: "controller", protocol: PROTOCOL });
  await first;
  return ws;
}

export function waitForTargets(ws, count, timeoutMs = 3000) {
  return nextMessage(ws, (m) => m.type === "targets" && m.targets.length === count, timeoutMs);
}
