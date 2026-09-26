require('dotenv').config();

const required = ['TOKEN', 'CLIENT_ID', 'MONGODB_URI'];
const missing = required.filter((key) => !process.env[key]);

if (missing.length > 0) {
  console.error(`❌ Missing required environment variables: ${missing.join(', ')}`);
  console.error('   Set these in your Render dashboard (or a local .env file).');
  process.exit(1);
}

// Optional-but-recommended vars — the dashboard/OAuth2 features degrade gracefully without them.
const optionalMissing = ['CLIENT_SECRET', 'REDIRECT_URI', 'SESSION_SECRET'].filter(
  (key) => !process.env[key]
);
if (optionalMissing.length > 0) {
  console.warn(
    `⚠️  Missing optional env vars: ${optionalMissing.join(
      ', '
    )}. The web dashboard OAuth2 login will not work until these are set.`
  );
}

module.exports = {
  // Preserved from original bot — same names, same meaning.
  BOT_TOKEN: process.env.TOKEN,
  CLIENT_ID: process.env.CLIENT_ID,

  // New
  CLIENT_SECRET: process.env.CLIENT_SECRET || null,
  REDIRECT_URI: process.env.REDIRECT_URI || null,
  SESSION_SECRET: process.env.SESSION_SECRET || 'insecure-dev-secret-change-me',
  MONGODB_URI: process.env.MONGODB_URI,
  PORT: process.env.PORT || 3000,

  LOOFARY_USER_ID: '1545263092370243624',

  // Leveling tuning knobs
  XP_MIN: 15,
  XP_MAX: 25,
  XP_COOLDOWN_MS: 60 * 1000,
  LEVEL_XP_BASE: 100 // XP needed for level N ≈ LEVEL_XP_BASE * N^1.5
};
