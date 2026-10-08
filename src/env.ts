// Load .env for local dev (imported first by server.ts so config sees the values). Firebase loads .env itself.
try {
  process.loadEnvFile(".env");
} catch {
  // no .env — fine
}
