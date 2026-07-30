// The NEUTRAL tool-calling wire for the `chat` capability, and the pure
// translators each provider adapter uses to speak it natively. One convention,
// three dialects:
//
//   neutral (what chat.ts sends/receives via ai.invoke):
//     input.tools:    [{ name, description, parameters (JSON schema) }]
//     input.messages: [{ role: user|assistant|tool, content,
//                        tool_calls?: [{id,name,args}], tool_call_id? }]
//     result:         { role, content, tool_calls?: [{id,name,args}] }
//
//   anthropic: tools → [{name,description,input_schema}]; assistant calls →
//     tool_use blocks; tool turns → user turns with tool_result blocks.
//   openai (+compat/OpenRouter): tools → [{type:"function",function:{…}}];
//     assistant calls carry JSON-STRING arguments; tool turns are role:"tool"
//     with tool_call_id.
//   ollama (+edge-bridge): OpenAI-shaped tools; arguments are OBJECTS not
//     strings; no call ids (synthesized on parse); tool turns match by order.
//
// Everything here is pure — adapters do the fetching.

export interface ToolDef {
  name: string;
  description: string;
  /** JSON schema (from @cobblr/workspace-tools jsonSchemaOf). */
  parameters: unknown;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ChatTurn {
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

function safeParseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      const p = JSON.parse(raw) as unknown;
      if (p && typeof p === "object") return p as Record<string, unknown>;
    } catch {
      /* fall through */
    }
  }
  return {};
}

export function toolsOf(input: Record<string, unknown>): ToolDef[] | null {
  const t = input.tools;
  return Array.isArray(t) && t.length ? (t as ToolDef[]) : null;
}

export function turnsOf(input: Record<string, unknown>): ChatTurn[] {
  return ((input.messages as ChatTurn[]) ?? []).filter((m) => !!m && typeof m.role === "string");
}

// ── OpenAI dialect (openai, openai-compat, OpenRouter) ──────────────────

export function openAiToolsOf(defs: ToolDef[]): unknown[] {
  return defs.map((d) => ({
    type: "function",
    function: { name: d.name, description: d.description, parameters: d.parameters },
  }));
}

export function openAiMessagesOf(turns: ChatTurn[]): unknown[] {
  return turns.map((m) => {
    if (m.role === "assistant" && m.tool_calls?.length) {
      return {
        role: "assistant",
        content: m.content || null,
        tool_calls: m.tool_calls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
        })),
      };
    }
    if (m.role === "tool") {
      return { role: "tool", tool_call_id: m.tool_call_id ?? "", content: m.content };
    }
    return { role: m.role, content: m.content };
  });
}

export function parseOpenAiToolCalls(msg: {
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }>;
}): ToolCall[] | undefined {
  const raw = msg.tool_calls;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  return raw.map((c, i) => ({
    id: c.id || `call_${i}`,
    name: c.function?.name ?? "",
    args: safeParseArgs(c.function?.arguments),
  }));
}

// ── Ollama dialect (ollama, edge-bridge) ────────────────────────────────
// Same tool DEFS as OpenAI; arguments are objects; no ids; tool results are
// bare role:"tool" turns matched positionally.

export function ollamaMessagesOf(turns: ChatTurn[]): unknown[] {
  return turns.map((m) => {
    if (m.role === "assistant" && m.tool_calls?.length) {
      return {
        role: "assistant",
        content: m.content ?? "",
        tool_calls: m.tool_calls.map((c) => ({ function: { name: c.name, arguments: c.args ?? {} } })),
      };
    }
    if (m.role === "tool") return { role: "tool", content: m.content };
    return { role: m.role, content: m.content };
  });
}

export function parseOllamaToolCalls(msg: {
  tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }>;
}): ToolCall[] | undefined {
  const raw = msg.tool_calls;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  return raw.map((c, i) => ({
    id: `call_${i}`,
    name: c.function?.name ?? "",
    args: safeParseArgs(c.function?.arguments),
  }));
}

/** An upstream 4xx that means "this model/server doesn't do tools" — the cue
 *  to retry the request once without them (graceful no-tools degrade). */
export function looksLikeNoToolSupport(status: number, bodyText: string): boolean {
  return status >= 400 && status < 500 && /tool/i.test(bodyText);
}

// ── Anthropic dialect ───────────────────────────────────────────────────

export function anthropicToolsOf(defs: ToolDef[]): unknown[] {
  return defs.map((d) => ({ name: d.name, description: d.description, input_schema: d.parameters }));
}

export function anthropicMessagesOf(turns: ChatTurn[]): Array<{ role: string; content: unknown }> {
  return turns.map((m) => {
    if (m.role === "assistant" && m.tool_calls?.length) {
      const blocks: unknown[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const c of m.tool_calls) blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.args ?? {} });
      return { role: "assistant", content: blocks };
    }
    if (m.role === "tool") {
      return {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: m.tool_call_id ?? "", content: m.content }],
      };
    }
    return { role: m.role, content: [{ type: "text", text: m.content }] };
  });
}

export function parseAnthropicContent(
  content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>,
): { text: string; tool_calls?: ToolCall[] } {
  const text = content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
  const calls = content
    .filter((c) => c.type === "tool_use")
    .map((c, i) => ({ id: c.id || `call_${i}`, name: c.name ?? "", args: safeParseArgs(c.input) }));
  return calls.length ? { text, tool_calls: calls } : { text };
}

/** Token usage from a bridge response, whatever shape it speaks.
 *
 *  A "bridge" is any local program a user points us at, so the wire format is
 *  whatever that program happens to emit. We only read Ollama's
 *  prompt_eval_count / eval_count, so a bridge that proxies an
 *  Anthropic- or OpenAI-shaped API reported its usage and we threw it away —
 *  every one of those calls logged 0/0 tokens, which reads like a measured zero
 *  rather than "nobody told us".
 *
 *  Returns {} when the response carries no usage at all, so the caller records
 *  null and the UI can say "tokens not reported" honestly. Never invents a 0.
 */
export function bridgeUsage(body: unknown): {
  input_tokens?: number;
  output_tokens?: number;
} {
  const b = (body ?? {}) as Record<string, unknown>;
  const u = (b.usage ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;

  const input =
    num(b.prompt_eval_count) ?? // Ollama
    num(u.input_tokens) ?? //     Anthropic
    num(u.prompt_tokens); //      OpenAI
  const output =
    num(b.eval_count) ?? //       Ollama
    num(u.output_tokens) ?? //    Anthropic
    num(u.completion_tokens); //  OpenAI

  return {
    ...(input !== undefined ? { input_tokens: input } : {}),
    ...(output !== undefined ? { output_tokens: output } : {}),
  };
}
