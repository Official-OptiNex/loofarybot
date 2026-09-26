const mongoose = require('mongoose');

// A point-in-time snapshot of a server's settings (and optionally member XP).
const ConfigBackupSchema = new mongoose.Schema(
  {
    guildId: { type: String, required: true, index: true },
    reason: { type: String, enum: ['daily', 'manual', 'before-import', 'before-restore'], default: 'manual' },
    createdBy: { type: String, default: null }, // username, or null for automatic backups
    sizeBytes: { type: Number, default: 0 },
    memberCount: { type: Number, default: 0 }, // XP records included
    data: { type: mongoose.Schema.Types.Mixed, required: true }
  },
  { timestamps: true }
);

ConfigBackupSchema.index({ guildId: 1, createdAt: -1 });

module.exports = mongoose.model('ConfigBackup', ConfigBackupSchema);
