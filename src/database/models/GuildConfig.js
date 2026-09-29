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
    // /daily streak rewards. XP = base + min(bonusPerDay × (streak − 1), maxBonus) (+ milestone bonus).
    daily: {
      enabled: { type: Boolean, default: true },
      baseXp: { type: Number, default: 50 },
      bonusPerDay: { type: Number, default: 10 },
      maxBonus: { type: Number, default: 200 },
      milestoneEvery: { type: Number, default: 7 },
      milestoneBonus: { type: Number, default: 250 }
    },
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
    gamblingMaxWin: { type: Number, default: null }, // most XP profit from one game; null = no cap
    gamblingDailyLimit: { type: Number, default: 10 }, // games per member per UTC day; 0 = unlimited
    gamblingDailyWinCap: { type: Number, default: 1000 }, // most XP a member can come out ahead per UTC day; 0 = no cap
    boosterPerks: {
      enabled: { type: Boolean, default: true },
      extraGambles: { type: Number, default: 5 }, // added to the daily gamble limit
      giveawayEntries: { type: Number, default: 2 }, // extra tickets in every timed giveaway
      dailyXp: { type: Number, default: 100 }, // automatic daily XP drop
      boostXp: { type: Number, default: 500 }, // one-time thank-you package when someone boosts
      channelId: { type: String, default: null } // where drops and thank-yous are announced (optional)
    },
    boosterDropDay: { type: String, default: null }, // UTC day the last daily booster drop went out
    // Random XP drops in chat (/xpdrop or dashboard Leveling → Chat drops).
    chatDrops: {
      enabled: { type: Boolean, default: false },
      channelIds: { type: [String], default: [] },
      minXp: { type: Number, default: 50 },
      maxXp: { type: Number, default: 250 },
      minMinutes: { type: Number, default: 30 }, // time between drops is random in this range
      maxMinutes: { type: Number, default: 90 },
      minActivity: { type: Number, default: 3 }, // messages in the last 10 minutes before a channel gets a drop
      claimSeconds: { type: Number, default: 120 }, // how long a drop stays claimable
      nextDropAt: { type: Date, default: null },
      lastDropAt: { type: Date, default: null }
    },
    // Birthdays (/birthday, dashboard Engagement → Birthdays): one post a day, at announceHour UTC.
    birthdays: {
      enabled: { type: Boolean, default: false },
      channelId: { type: String, default: null },
      roleId: { type: String, default: null }, // given for the day, removed the next day
      xpGift: { type: Number, default: 0 },
      announceHour: { type: Number, default: 14 }, // UTC
      message: { type: String, default: '🎂 Happy birthday {users}! Have an amazing day! 🎉' },
      lastRunDay: { type: String, default: null } // 'YYYY-MM-DD' of the last announcement (so restarts don't repeat it)
    },
    // Counting game (/counting, dashboard Engagement → Counting).
    counting: {
      enabled: { type: Boolean, default: false },
      channelId: { type: String, default: null },
      current: { type: Number, default: 0 },
      lastUserId: { type: String, default: null },
      lastMessageId: { type: String, default: null },
      lastCountAt: { type: Date, default: null },
      record: { type: Number, default: 0 },
      bestBefore: { type: Number, default: 0 }, // best run before the current one (for the 🏆 when it's beaten)
      allowSameUser: { type: Boolean, default: false }, // false = people have to take turns
      mathAllowed: { type: Boolean, default: true }, // "2*5" counts as 10
      resets: { type: Number, default: 0 },
      lastResetBy: { type: String, default: null }
    },
    // Starboard (/starboard, dashboard Engagement → Starboard).
    starboard: {
      enabled: { type: Boolean, default: false },
      channelId: { type: String, default: null },
      emoji: { type: String, default: '⭐' },
      threshold: { type: Number, default: 3 },
      selfStar: { type: Boolean, default: false },
      ignoredChannelIds: { type: [String], default: [] }
    },
    gamblingChannelId: { type: String, default: null }, // null = any channel
    // Safety net: a player who gambles below the minimum bet gets one free bet (at most once per cooldown).
    gamblingFreePlayEnabled: { type: Boolean, default: true },
    gamblingFreePlayAmount: { type: Number, default: 300 },
    gamblingFreePlayCooldownHours: { type: Number, default: 24 },

    // --- Logging ---
    logsEnabled: { type: Boolean, default: true },
    // Staff channel for bot problems (missing permissions, failed role changes, errors).
    alertsChannelId: { type: String, default: null },

    // --- Go-live / upload alerts (subscriptions live in AlertSubscription) ---
    socialAlertsEnabled: { type: Boolean, default: true },

    // --- Dashboard access for moderators (admins always have full access) ---
    dashboardAccess: {
      modRoleIds: { type: [String], default: [] },
      modPages: { type: [String], default: ['leaderboard', 'commands', 'logviewer'] }
    },
    logChannelId: { type: String, default: null },
    logEvents: {
      messageEdit: { type: Boolean, default: true },
      messageDelete: { type: Boolean, default: true },
      memberJoin: { type: Boolean, default: true },
      memberLeave: { type: Boolean, default: true },
      voice: { type: Boolean, default: true },
      roles: { type: Boolean, default: true },
      modActions: { type: Boolean, default: true }
    },

    // --- Moderation cases ---
    caseCounter: { type: Number, default: 0 },
    // Warning escalation: when a member reaches `count` active warnings, this action runs automatically.
    warnEscalation: {
      type: [
        new mongoose.Schema(
          {
            count: { type: Number, required: true },
            action: { type: String, enum: ['timeout', 'kick', 'ban'], required: true },
            durationMs: { type: Number, default: null } // timeouts (and temporary bans)
          },
          { _id: false }
        )
      ],
      default: []
    },
    modDmEnabled: { type: Boolean, default: true }, // DM members when they're warned / timed out / kicked / banned

    // --- Lockdown ---
    lockdownOverwrites: { type: [LockdownOverwriteSchema], default: [] },

    // --- Media-only channels: posts without an attachment (or link, if allowed) are removed ---
    mediaOnlyChannels: {
      type: [
        new mongoose.Schema(
          {
            channelId: { type: String, required: true },
            allowLinks: { type: Boolean, default: true }, // links count as media (YouTube, Tenor, image URLs…)
            autoThread: { type: Boolean, default: false }, // open a comment thread on every post
            staffBypass: { type: Boolean, default: true } // Manage Messages members can post anything
          },
          { _id: false }
        )
      ],
      default: []
    },

    // --- Auto-Role ---
    autoRoleId: { type: String, default: null },
    autoRoleEnabled: { type: Boolean, default: true }
  },
  { timestamps: true }
);

module.exports = mongoose.model('GuildConfig', GuildConfigSchema);
