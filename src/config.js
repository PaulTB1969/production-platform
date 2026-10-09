// All configuration comes from environment variables (see .env.example).
// Secrets — the master key, the database password — live only in the
// server's .env file, never in the repo. Customers' Unleashed keys are
// stored encrypted in the database, per site.

export function loadConfig(env = process.env) {
  const config = {
    port: Number(env.PORT || 3000),
    databaseUrl: env.DATABASE_URL || null,
    // Used only when DATABASE_URL is unset (local dev): where PGlite keeps its files.
    pgliteDir: env.PGLITE_DIR || './.data/pglite',
    unleashed: {
      clientType: env.UNLEASHED_CLIENT_TYPE || 'production-platform',
      // Minutes between automatic syncs of BOMs and batch stock. 0 = off.
      syncIntervalMinutes: Number(env.UNLEASHED_SYNC_MINUTES ?? 60),
    },
    // Goes in the Production Person Email column of both schedule exports.
    // Becomes a per-site setting in phase 3.
    productionEmail: env.PRODUCTION_EMAIL || null,
    // Encrypts customers' Unleashed API keys in the database (see secrets.js).
    masterKey: env.MASTER_KEY || null,
    isProduction: env.NODE_ENV === 'production',
  };

  if (config.isProduction) {
    const missing = [];
    if (!config.databaseUrl) missing.push('DATABASE_URL');
    if (!config.masterKey) missing.push('MASTER_KEY');
    if (missing.length) throw new Error(`Missing required settings in production: ${missing.join(', ')}`);
  }
  return config;
}
