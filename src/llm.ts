import { config } from "./config.js";

export interface AgentTool {
  name: string;
  description: string;
  /** JSON schema for the arguments. */
  parameters: Record<string, unknown>;
  run(args: any): Promise<string>;
  /** If true, calling this tool ends the loop; its return value becomes the result. */
  terminal?: boolean;
}

export interface AgentRunResult {
  output: string;
  steps: number;
  toolCalls: { name: string; args: unknown }[];
  usage: { input: number; output: number };
}

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  thinking?: string;
  tool_calls?: { function: { name: string; arguments: unknown } }[];
  tool_name?: string;
}

async function chat(model: string, messages: OllamaMessage[], tools: AgentTool[]) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.llm.apiKey) headers.Authorization = `Bearer ${config.llm.apiKey}`;
  const res = await fetch(`${config.llm.baseUrl}/api/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      options: { temperature: 0.2 },
      tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err: any = new Error(`LLM ${res.status}: ${body.slice(0, 500)}`);
    err.status = res.status;
    throw err;
  }
  return (await res.json()) as { message: OllamaMessage; prompt_eval_count?: number; eval_count?: number };
}

/**
 * A minimal tool-calling agent loop over the Ollama chat API.
 * Iterates until the model calls a terminal tool, replies with plain text, or hits the step limit.
 * With `requireTerminal`, a plain-text reply gets a nudge to call the terminal tool (open models sometimes forget).
 */
export async function runAgent(opts: {
  model: string;
  system: string;
  task: string;
  tools: AgentTool[];
  maxSteps?: number;
  requireTerminal?: boolean;
  label?: string;
}): Promise<AgentRunResult> {
  const maxSteps = opts.maxSteps ?? config.llm.maxSteps;
  const byName = new Map(opts.tools.map((t) => [t.name, t]));
  const terminal = opts.tools.find((t) => t.terminal);
  const messages: OllamaMessage[] = [
    { role: "system", content: opts.system },
    { role: "user", content: opts.task },
  ];
  const result: AgentRunResult = { output: "", steps: 0, toolCalls: [], usage: { input: 0, output: 0 } };
  let nudges = 0;

  for (let step = 0; step < maxSteps; step++) {
    result.steps = step + 1;
    const res = await withRetry(() => chat(opts.model, messages, opts.tools));
    result.usage.input += res.prompt_eval_count ?? 0;
    result.usage.output += res.eval_count ?? 0;
    const msg = res.message ?? { role: "assistant", content: "" };
    messages.push({ role: "assistant", content: msg.content ?? "", thinking: msg.thinking, tool_calls: msg.tool_calls });

    const calls = msg.tool_calls ?? [];
    if (!calls.length) {
      if (opts.requireTerminal && terminal && nudges < 2) {
        nudges++;
        messages.push({ role: "user", content: `If you are done, call the ${terminal.name} tool now. Otherwise continue using the tools.` });
        continue;
      }
      result.output = (msg.content ?? "").trim();
      return result;
    }

    let terminalOutput: string | null = null;
    for (const call of calls) {
      const name = call.function?.name ?? "";
      let args: any = call.function?.arguments ?? {};
      if (typeof args === "string") {
        try {
          args = JSON.parse(args);
        } catch {
          args = {};
        }
      }
      result.toolCalls.push({ name, args });
      const tool = byName.get(name);
      let out: string;
      if (!tool) out = `Error: unknown tool ${name}. Available: ${[...byName.keys()].join(", ")}`;
      else {
        try {
          out = await tool.run(args);
        } catch (e) {
          out = `Error: ${(e as Error).message}`;
        }
        if (tool.terminal && !out.startsWith("Error")) terminalOutput = out;
      }
      if (process.env.MAAS_DEBUG) console.log(`[${opts.label}] ${name}(${JSON.stringify(args).slice(0, 200)}) -> ${out.slice(0, 200)}`);
      messages.push({ role: "tool", tool_name: name, content: truncate(out, 30_000) });
    }
    if (terminalOutput !== null) {
      result.output = terminalOutput;
      return result;
    }
  }
  throw new Error(`[${opts.label}] agent exceeded ${maxSteps} steps`);
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n) + `\n…[truncated ${s.length - n} chars]` : s;
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e: any) {
      last = e;
      const retryable = [429, 500, 502, 503, 504].includes(e?.status) || /fetch failed|timeout|ECONNRESET/i.test(String(e?.message));
      if (!retryable || i === attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, 1500 * 2 ** i + Math.random() * 500));
    }
  }
  throw last;
}
