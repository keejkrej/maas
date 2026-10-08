import path from "node:path";

function env(name: string, fallback?: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

const onFirebase = !!(process.env.K_SERVICE || process.env.FUNCTION_TARGET || process.env.FIREBASE_CONFIG);

/** Read lazily: on Firebase, secrets are injected as env vars at runtime. */
export const config = {
  get port() {
    return Number(env("PORT", "8080"));
  },

  /** Server admin token: creates teams and manages any team. Members use their own API keys. */
  get adminToken() {
    return env("MAAS_ADMIN_TOKEN");
  },

  /** Firestore in production (on Firebase or when MAAS_STORE=firestore), local JSON file otherwise. */
  useFirestore: env("MAAS_STORE", onFirebase ? "firestore" : "local") === "firestore",

  /** True when running as Firebase Functions (work is triggered by Firestore events, not in-process). */
  onFirebase,

  dataDir: path.resolve(env("MAAS_DATA_DIR", ".data")!),

  /** LLM: Ollama API (Ollama Cloud by default; point MAAS_LLM_URL at http://localhost:11434 for local Ollama). */
  llm: {
    get baseUrl() {
      return env("MAAS_LLM_URL", "https://ollama.com")!.replace(/\/+$/, "");
    },
    get apiKey() {
      return env("OLLAMA_API_KEY");
    },
    /** Model for ingest + recall. */
    get agentModel() {
      return env("MAAS_AGENT_MODEL", "gpt-oss:120b")!;
    },
    /** Model for dreaming (consolidation); a stronger model helps. */
    get dreamModel() {
      return env("MAAS_DREAM_MODEL", env("MAAS_AGENT_MODEL", "gpt-oss:120b"))!;
    },
    get maxSteps() {
      return Number(env("MAAS_MAX_AGENT_STEPS", "24"));
    },
  },

  /** Queue a dream after this many integrated observations per team (0 disables). */
  get dreamEvery() {
    return Number(env("MAAS_DREAM_EVERY", "25"));
  },
};

export type Config = typeof config;
