// Load .env, then .env.local (local-only secrets), for local dev. Imported first by server.ts so config sees the values.
// On Firebase, .env is loaded by the platform and secrets come from Secret Manager.
for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(file); // doesn't override vars that are already set, so .env.local wins
  } catch {
    // file missing — fine
  }
}
