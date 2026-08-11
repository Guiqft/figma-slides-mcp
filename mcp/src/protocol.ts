// Wire protocol shared by the broker, the MCP server (controller) and the plugin UI.
// Every `hello` carries `protocol`; a mismatch is a hard stop, not a degraded mode.

export const PROTOCOL_VERSION = 1;
export const DEFAULT_BROKER_PORT = 3055;

export interface TargetInfo {
  connId: string;
  docName: string;
  editorType: string;
}

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
