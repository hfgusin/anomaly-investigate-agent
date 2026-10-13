import { setTimeout as delay } from "node:timers/promises";
import type { ChatMessage } from "./session-store.js";
import type { ToolResult } from "./tools/read-file.js";

export type RuntimeInput = {
  runId?: string;
  debugEvent?: (event: string, payload: Record<string, unknown>) => void;
  messages: ChatMessage[]; signal: AbortSignal;
  callTool?: (call: { id: string; name: string; arguments: string }, executePython?: (argumentsJson: string) => Promise<ToolResult>) => Promise<ToolResult>;
  toolDefinitions?: unknown[];
  activeToolNames?: string[];
  maxToolResultChars?: number;
  skillInstruction?: string;
  hostedSearch?: boolean;
  toolResultMode?: "standard" | "plain";
};
export type RuntimeInfo = { kind: "demo" | "chat-completions" | "responses"; label: string; model: string | null; webSearch?: boolean };
export type RuntimeChunk = string | { type: "discard"; chars: number } | { type: "provider_event"; event: string; payload: Record<string, unknown> };
export interface AgentRuntime {
  readonly info: RuntimeInfo;
  promptOverheadChars?(toolDefinitions?: unknown[], skillInstruction?: string): number;
  limits?(): unknown;
  stream(input: RuntimeInput): AsyncIterable<RuntimeChunk>;
}

/** This transport demo makes no model requests and cannot answer questions. */
export class DemoRuntime implements AgentRuntime {
  readonly info: RuntimeInfo = { kind: "demo", label: "演示模式 · 未连接模型", model: null };

  async *stream(input: RuntimeInput): AsyncIterable<string> {
    const last = input.messages.at(-1)?.content ?? "";
    const reply = `【演示回声】收到：${last}\n\n会话、排队和停止可以体验；真实回答需要配置模型接口。`;
    for (const chunk of reply.match(/[\s\S]{1,4}/gu) ?? []) {
      input.signal.throwIfAborted();
      yield chunk;
      await delay(35, undefined, { signal: input.signal });
    }
  }
}
