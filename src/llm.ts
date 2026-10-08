import { GoogleGenAI, type Content, type FunctionDeclaration, type Part } from "@google/genai";
import { config } from "./config.js";

let client: GoogleGenAI | null = null;
function ai() {
  if (!client) {
    client = config.llm.useVertex
      ? new GoogleGenAI({ vertexai: true, project: config.llm.project, location: config.llm.location })
      : new GoogleGenAI({ apiKey: config.llm.apiKey });
  }
  return client;
}

export interface AgentTool {
  name: string;
  description: string;
  /** JSON schema for the arguments. */
  parameters: Record<string, unknown>;
  run(args: any): Promise<string>;
  /** If true, calling this tool ends the loop; its argument `summary`/`answer` becomes the result. */
  terminal?: boolean;
}

export interface AgentRunResult {
  /** Final text (from a terminal tool or the model's last text reply). */
  output: string;
  steps: number;
  toolCalls: { name: string; args: unknown }[];
  usage: { input: number; output: number };
}

/**
 * A minimal tool-calling agent loop over Gemini.
 * The model gets a system prompt + tools and iterates until it calls a terminal tool,
 * replies with plain text, or hits the step limit.
 */
export async function runAgent(opts: {
  model: string;
  system: string;
  task: string;
  tools: AgentTool[];
  maxSteps?: number;
  label?: string;
}): Promise<AgentRunResult> {
  const maxSteps = opts.maxSteps ?? config.llm.maxSteps;
  const byName = new Map(opts.tools.map((t) => [t.name, t]));
  const declarations: FunctionDeclaration[] = opts.tools.map((t) => ({
    name: t.name,
    description: t.description,
    parametersJsonSchema: t.parameters,
  }));
  const contents: Content[] = [{ role: "user", parts: [{ text: opts.task }] }];
  const result: AgentRunResult = { output: "", steps: 0, toolCalls: [], usage: { input: 0, output: 0 } };

  for (let step = 0; step < maxSteps; step++) {
    result.steps = step + 1;
    const res = await withRetry(() =>
      ai().models.generateContent({
        model: opts.model,
        contents,
        config: {
          systemInstruction: opts.system,
          tools: [{ functionDeclarations: declarations }],
          temperature: 0.2,
        },
      }),
    );
    result.usage.input += res.usageMetadata?.promptTokenCount ?? 0;
    result.usage.output += res.usageMetadata?.candidatesTokenCount ?? 0;

    const modelContent = res.candidates?.[0]?.content;
    if (!modelContent) throw new Error(`[${opts.label}] model returned no content (${res.candidates?.[0]?.finishReason})`);
    // Push the full model turn back (preserves thought signatures required by Gemini 3+).
    contents.push({ role: "model", parts: modelContent.parts ?? [] });

    const calls = res.functionCalls ?? [];
    if (!calls.length) {
      result.output = (res.text ?? "").trim();
      return result;
    }

    const responses: Part[] = [];
    let terminalOutput: string | null = null;
    for (const call of calls) {
      const tool = byName.get(call.name ?? "");
      result.toolCalls.push({ name: call.name ?? "?", args: call.args });
      let out: string;
      if (!tool) {
        out = `Error: unknown tool ${call.name}`;
      } else {
        try {
          out = await tool.run(call.args ?? {});
        } catch (e) {
          out = `Error: ${(e as Error).message}`;
        }
        if (tool.terminal && !out.startsWith("Error")) terminalOutput = out;
      }
      if (process.env.MAAS_DEBUG) console.log(`[${opts.label}] ${call.name}(${JSON.stringify(call.args).slice(0, 200)}) -> ${out.slice(0, 200)}`);
      responses.push({ functionResponse: { id: call.id, name: call.name, response: { result: truncate(out, 40_000) } } });
    }
    contents.push({ role: "user", parts: responses });
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
      const status = e?.status ?? e?.code;
      const retryable = status === 429 || status === 503 || status === 500 || /RESOURCE_EXHAUSTED|UNAVAILABLE|fetch failed/i.test(String(e?.message));
      if (!retryable || i === attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i + Math.random() * 500));
    }
  }
  throw last;
}
