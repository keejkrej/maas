import path from "node:path";

function env(name: string, fallback?: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

export const config = {
  port: Number(env("PORT", "8080")),

  /** Shared secret clients must send (Authorization: Bearer <token>, or ?key=<token>). */
  authToken: env("MAAS_TOKEN"),

  /** Name of the person/team this memory belongs to (shown in MEMORY.md header). */
  ownerName: env("MAAS_OWNER", "Owner")!,

  /** Local working copy of the memory repo. On Cloud Run this lives in the in-memory FS. */
  repoDir: path.resolve(env("MAAS_REPO_DIR", ".data/memory")!),

  /** Where the inbox journal lives locally (mirrored to GCS when configured). */
  stateDir: path.resolve(env("MAAS_STATE_DIR", ".data/state")!),

  /** GCS bucket used to persist the repo (as a git bundle) and the inbox journal. */
  gcsBucket: env("MAAS_GCS_BUCKET"),
  gcsPrefix: env("MAAS_GCS_PREFIX", "maas")!,

  /** Optional git remote (e.g. a private GitHub repo with a token in the URL). Pushed after every commit. */
  gitRemote: env("MAAS_GIT_REMOTE"),

  /** LLM settings. On Cloud Run we use Vertex AI with the service account (no API key). */
  llm: {
    useVertex: env("GOOGLE_GENAI_USE_VERTEXAI", env("GEMINI_API_KEY") ? "false" : "true") === "true",
    apiKey: env("GEMINI_API_KEY"),
    project: env("GOOGLE_CLOUD_PROJECT"),
    location: env("GOOGLE_CLOUD_LOCATION", "global")!,
    /** Model used to integrate new observations and answer recall queries. */
    agentModel: env("MAAS_AGENT_MODEL", "gemini-3.5-flash")!,
    /** Model used for the periodic dreaming/consolidation pass. */
    dreamModel: env("MAAS_DREAM_MODEL", env("MAAS_AGENT_MODEL", "gemini-3.5-flash"))!,
    maxSteps: Number(env("MAAS_MAX_AGENT_STEPS", "24")),
  },

  /** Dream automatically after this many integrated observations (0 disables). Cloud Scheduler can also hit /dream. */
  dreamEvery: Number(env("MAAS_DREAM_EVERY", "25")),
};

export type Config = typeof config;
