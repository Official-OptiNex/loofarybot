const mongoose = require('mongoose');

const LevelRoleSchema = new mongoose.Schema(
  {
    level: { type: Number, required: true },
    roleId: { type: String, required: true }
  },
  { _id: false }
);

const GuildConfigSchema = new mongoose.Schema(
  {
    guildId: { type: String, required: true, unique: true, index: true },

    // --- Honeypot ---
    honeypotChannelId: { type: String, default: null },
    honeypotAction: {
      type: String,
      enum: ['kick', 'softban', 'ban'],
      default: 'kick'
    },
    honeypotCounterMessageId: { type: String, default: null },
    honeypotKicks: { type: Number, default: 0 },
    honeypotSoftbans: { type: Number, default: 0 },
    honeypotBans: { type: Number, default: 0 },

    // --- Leveling ---
    levelingEnabled: { type: Boolean, default: true },
    levelRoles: { type: [LevelRoleSchema], default: [] },
    // Per-guild overrides. null/undefined means "use the global default from config.js".
    xpMin: { type: Number, default: null },
    xpMax: { type: Number, default: null },
    xpCooldownSeconds: { type: Number, default: null },
    levelXpBase: { type: Number, default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model('GuildConfig', GuildConfigSchema);
