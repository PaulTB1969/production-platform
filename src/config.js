// All configuration comes from environment variables (see .env.example).
// Secrets — the Unleashed API key, the database password, the app password —
// live only in the server's .env file, never in the repo.

export function loadConfig(env = process.env) {
  const config = {
    port: Number(env.PORT || 3000),
    databaseUrl: env.DATABASE_URL || null,
    // Used only when DATABASE_URL is unset (local dev): where PGlite keeps its files.
    pgliteDir: env.PGLITE_DIR || './.data/pglite',
    auth: {
      user: env.APP_USER || null,
      password: env.APP_PASSWORD || null,
    },
    unleashed: {
      apiId: env.UNLEASHED_API_ID || null,
      apiKey: env.UNLEASHED_API_KEY || null,
      baseUrl: env.UNLEASHED_BASE_URL || 'https://api.unleashedsoftware.com',
      clientType: env.UNLEASHED_CLIENT_TYPE || 'mountainfalls/production-hub',
      // Minutes between automatic syncs of BOMs and batch stock. 0 = off.
      syncIntervalMinutes: Number(env.UNLEASHED_SYNC_MINUTES ?? 60),
    },
    // Goes in the Production Person Email column of both schedule exports,
    // as in the artifact (per-person attribution isn't used yet).
    productionEmail: env.PRODUCTION_EMAIL || 'nicolette@mountainfalls.co.za',
    isProduction: env.NODE_ENV === 'production',
  };

  if (config.isProduction) {
    const missing = [];
    if (!config.databaseUrl) missing.push('DATABASE_URL');
    if (!config.auth.user || !config.auth.password) missing.push('APP_USER / APP_PASSWORD');
    if (missing.length) throw new Error(`Missing required settings in production: ${missing.join(', ')}`);
  }
  return config;
}
