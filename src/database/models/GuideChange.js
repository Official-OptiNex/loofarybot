const mongoose = require('mongoose');

// A guide change a guide editor asked for (add / edit / delete) that an admin must approve first.
const GuideChangeSchema = new mongoose.Schema(
  {
    guildId: { type: String, required: true, index: true },
    type: { type: String, enum: ['create', 'edit', 'delete'], required: true },
    slug: { type: String, default: null }, // the guide (edit / delete)
    title: { type: String, default: '' }, // shown in lists (the new title for create / edit)
    payload: { type: mongoose.Schema.Types.Mixed, default: null }, // { title, tags, body, messages, inIndex } for create / edit
    requestedBy: { type: String, required: true },
    requestedByTag: { type: String, default: null },
    status: { type: String, enum: ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'], default: 'PENDING', index: true },
    decidedBy: { type: String, default: null },
    decidedByTag: { type: String, default: null },
    decidedAt: { type: Date, default: null },
    note: { type: String, default: null },
    error: { type: String, default: null }, // why applying it failed (stays pending)
    channelId: { type: String, default: null }, // the approval message in Discord
    messageId: { type: String, default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model('GuideChange', GuideChangeSchema);
