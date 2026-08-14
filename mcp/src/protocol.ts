// Wire protocol shared by the broker, the MCP server (controller) and the plugin UI.
// Every `hello` carries `protocol`; a mismatch is a hard stop, not a degraded mode.

export const PROTOCOL_VERSION = 1;
export const DEFAULT_BROKER_PORT = 3055;

export interface TargetInfo {
  connId: string;
  docName: string;
  editorType: string;
  /** Registered through the legacy probe below rather than a `hello`. */
  legacy?: boolean;
}

/**
 * Pre-2.0 plugins never send a `hello` — they open the socket and wait for
 * `{id, command, params}`. So the broker asks: any answer carrying the probe id
 * identifies the socket as a plugin, and a 1.x `execute` hands back the file
 * name a `hello` would have carried. This is the one place the broker knows a
 * command name, and it is the price of not breaking every deck installed
 * before 2.0.
 */
export const LEGACY_PROBE_COMMAND = "execute";
export const LEGACY_PROBE_CODE = "return figma.root.name";
export const LEGACY_DOC_NAME = "Untitled (legacy plugin)";

export interface PluginHello {
  type: "hello";
  role: "plugin";
  protocol: number;
  docName?: string;
  editorType?: string;
}

export interface ControllerHello {
  type: "hello";
  role: "controller";
  protocol: number;
}

export interface CommandMessage {
  type: "command";
  id: string;
  target: string;
  command: string;
  params: Record<string, unknown>;
}

export interface TargetsMessage {
  type: "targets";
  targets: TargetInfo[];
  /**
   * Clients that opened a socket and never sent a `hello`. A pre-2.0 plugin
   * does exactly this, and without counting it the bridge looks simply empty.
   */
  unidentified?: number;
}

export interface ResponseMessage {
  type: "response";
  id: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export type BrokerErrorCode = "no_such_target" | "target_disconnected" | "protocol_mismatch";

export interface ErrorMessage {
  type: "error";
  code: BrokerErrorCode;
  id?: string;
  error?: string;
  brokerProtocol?: number;
}
