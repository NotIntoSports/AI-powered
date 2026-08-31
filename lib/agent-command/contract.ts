export const AGENT_COMMAND_TOPIC = "agent.command.v1";
export const AGENT_COMMAND_RESULT_TOPIC = "agent.command.result.v1";

export type AgentCommand = {
  id: string;
  action: "say" | "retry" | "correct" | "report";
  text?: string;
  answer?: string;
  expectedRevision: number;
  context?: {
    v: 1;
    role: string;
    topic: string;
    history: Array<{ role: string; text: string }>;
    resumeIds: string[];
  };
};

export type AgentCommandResult = {
  commandId: string;
  action: AgentCommand["action"];
  ok: boolean;
  result: Record<string, unknown>;
  error: string;
};

export function encodeAgentCommand(command: AgentCommand): Uint8Array<ArrayBuffer> {
  const encoded = new TextEncoder().encode(JSON.stringify({ v: 1, ...command }));
  const output = new Uint8Array(new ArrayBuffer(encoded.byteLength));
  output.set(encoded);
  return output;
}

export function parseAgentCommandResult(input: unknown): AgentCommandResult | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (value.v !== 1 || typeof value.commandId !== "string" || !["say", "retry", "correct", "report"].includes(String(value.action))) return null;
  if (typeof value.ok !== "boolean" || !value.result || typeof value.result !== "object" || Array.isArray(value.result)) return null;
  return {
    commandId: value.commandId,
    action: value.action as AgentCommand["action"],
    ok: value.ok,
    result: value.result as Record<string, unknown>,
    error: typeof value.error === "string" ? value.error : ""
  };
}

export function decodeAgentCommandResult(payload: Uint8Array): AgentCommandResult | null {
  try { return parseAgentCommandResult(JSON.parse(new TextDecoder().decode(payload))); } catch { return null; }
}
