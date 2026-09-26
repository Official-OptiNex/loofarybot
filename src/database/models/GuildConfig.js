const mongoose = require('mongoose');

const LevelRoleSchema = new mongoose.Schema(
  {
    level: { type: Number, required: true },
    roleId: { type: String, required: true }
  },
  { _id: false }
);

// One color tier. Auto tiers point at a role the bot created (roleId filled in lazily);
// custom tiers point at an existing role an admin chose instead.
const LevelColorTierSchema = new mongoose.Schema(
  {
    level: { type: Number, required: true },
    roleId: { type: String, default: null },
    custom: { type: Boolean, default: false },
    color: { type: String, default: null } // override for auto roles; null = palette color
  },
  { _id: false }
);

const XpMultiplierSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['channel', 'role'], required: true },
    targetId: { type: String, required: true },
    multiplier: { type: Number, required: true }
  },
  { _id: false }
);

// One saved permission overwrite per (channel, role) touched by /lockdown, so /unlockdown
// can put each permission back exactly how it was instead of blindly clearing it.
const LockdownOverwriteSchema = new mongoose.Schema(
  {
    channelId: { type: String, required: true },
    targetId: { type: String, required: true },
    hadOverwrite: { type: Boolean, default: false },
    prevAllow: { type: [String], default: [] },
    prevDeny: { type: [String], default: [] }
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
    honeypotEnabled: { type: Boolean, default: true },
    honeypotDmEnabled: { type: Boolean, default: true }, // explain the removal to the member by DM
    // Customizable look of the trap message so it can be disguised as something innocent.
    honeypotEmbed: {
      title: { type: String, default: '' },
      description: { type: String, default: '' },
      color: { type: String, default: '' },
      footer: { type: String, default: '' },
      imageUrl: { type: String, default: '' },
      thumbnailUrl: { type: String, default: '' },
      showCounts: { type: Boolean, default: true }
    },

    // --- Leveling ---
    levelingEnabled: { type: Boolean, default: true },
    levelRoles: { type: [LevelRoleSchema], default: [] },
    // Per-guild overrides. null/undefined means "use the global default from config.js".
    xpMin: { type: Number, default: null },
    xpMax: { type: Number, default: null },
    xpCooldownSeconds: { type: Number, default: null },
    levelXpBase: { type: Number, default: null },
    // Where level-up announcements go. null means "the same channel the user was chatting in".
    levelUpChannelId: { type: String, default: null },
    xpMultipliers: { type: [XpMultiplierSchema], default: [] },
    rankCardBoosterOnly: { type: Boolean, default: false },
    // Cosmetic name-color roles: members hold the color role for the highest tier they've reached.
    levelColors: {
      enabled: { type: Boolean, default: false },
      interval: { type: Number, default: 5 },
      maxLevel: { type: Number, default: 100 },
      // low = just above @everyone · high = just below LoofaryBot's own role · above = above anchorRoleId
      placement: { type: String, enum: ['low', 'high', 'above'], default: 'low' },
      anchorRoleId: { type: String, default: null },
      tiers: { type: [LevelColorTierSchema], default: [] }
    },

    // --- XP Gambling ---
    gamblingEnabled: { type: Boolean, default: true },
    gamblingHouseEdge: { type: Number, default: 4 }, // percent
    gamblingMinBet: { type: Number, default: 10 },
    gamblingMaxBet: { type: Number, default: null }, // null = no cap
    gamblingChannelId: { type: String, default: null }, // null = any channel

    // --- Logging ---
    logsEnabled: { type: Boolean, default: true },
    logChannelId: { type: String, default: null },
    logEvents: {
      messageEdit: { type: Boolean, default: true },
      messageDelete: { type: Boolean, default: true },
      memberJoin: { type: Boolean, default: true },
      memberLeave: { type: Boolean, default: true },
      voice: { type: Boolean, default: true },
      roles: { type: Boolean, default: true }
    },

    // --- Lockdown ---
    lockdownOverwrites: { type: [LockdownOverwriteSchema], default: [] },

    // --- Auto-Role ---
    autoRoleId: { type: String, default: null },
    autoRoleEnabled: { type: Boolean, default: true }
  },
  { timestamps: true }
);

module.exports = mongoose.model('GuildConfig', GuildConfigSchema);
