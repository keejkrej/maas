import path from "node:path";

function env(name: string, fallback?: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

export const config = {
  port: Number(env("PORT", "8080")),

  /**
   * Server admin token: creates teams and manages any team. Members authenticate with their own
   * per-member API keys (issued via the admin API). MAAS_TOKEN is accepted as a legacy alias.
   */
  adminToken: env("MAAS_ADMIN_TOKEN", env("MAAS_TOKEN")),

  /** Local working directory: teams/<id>/memory holds each team's git repo. Ephemeral on Cloud Run. */
  dataDir: path.resolve(env("MAAS_DATA_DIR", ".data")!),

  /** Blob store root for local dev (registry, inbox journals). Ignored when MAAS_GCS_BUCKET is set. */
  stateDir: path.resolve(env("MAAS_STATE_DIR", ".data/state")!),

  /** GCS bucket for durable state: team registry, inbox journals, git bundle snapshots. */
  gcsBucket: env("MAAS_GCS_BUCKET"),
  gcsPrefix: env("MAAS_GCS_PREFIX", "maas")!,

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

  /** Dream automatically after this many integrated observations per team (0 disables). */
  dreamEvery: Number(env("MAAS_DREAM_EVERY", "25")),
};

export type Config = typeof config;
