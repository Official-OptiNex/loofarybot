const mongoose = require('mongoose');

// One moderator action (warn, timeout, kick, ban…). Numbered per server: case #1, #2, …
const ModCaseSchema = new mongoose.Schema(
  {
    guildId: { type: String, required: true },
    caseId: { type: Number, required: true },
    type: { type: String, enum: ['warn', 'timeout', 'untimeout', 'kick', 'ban', 'unban'], required: true },
    userId: { type: String, required: true },
    userTag: { type: String, default: '' },
    moderatorId: { type: String, required: true },
    moderatorTag: { type: String, default: '' },
    reason: { type: String, default: '' },
    durationMs: { type: Number, default: null }, // timeouts and temporary bans
    expiresAt: { type: Date, default: null }, // temporary bans: when to unban
    active: { type: Boolean, default: true }, // warns count toward escalation while active; temp bans until lifted
    auto: { type: Boolean, default: false }, // created by warning escalation or auto-mod
    source: { type: String, default: null }, // 'automod' for auto-mod strikes
    dmSent: { type: Boolean, default: false },
    revokedBy: { type: String, default: null },
    revokedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

ModCaseSchema.index({ guildId: 1, caseId: 1 }, { unique: true });
ModCaseSchema.index({ guildId: 1, userId: 1, createdAt: -1 });
ModCaseSchema.index({ type: 1, active: 1, expiresAt: 1 });

module.exports = mongoose.model('ModCase', ModCaseSchema);
