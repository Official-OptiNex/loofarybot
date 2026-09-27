const mongoose = require('mongoose');

const TranscriptLineSchema = new mongoose.Schema(
  {
    authorId: String,
    authorTag: String,
    bot: Boolean,
    content: String,
    attachments: { type: [String], default: [] },
    at: Date
  },
  { _id: false }
);

// One per ticket, open or closed.
const TicketSchema = new mongoose.Schema(
  {
    guildId: { type: String, required: true, index: true },
    channelId: { type: String, required: true, index: true },
    number: { type: Number, required: true },
    openerId: { type: String, required: true },
    openerTag: { type: String, default: null },
    reason: { type: String, default: null }, // what they said they need help with
    status: { type: String, enum: ['OPEN', 'CLOSED'], default: 'OPEN', index: true },
    claimedBy: { type: String, default: null },
    claimedByTag: { type: String, default: null },
    addedUserIds: { type: [String], default: [] },
    closedBy: { type: String, default: null },
    closedByTag: { type: String, default: null },
    closeReason: { type: String, default: null },
    closedAt: { type: Date, default: null },
    messageCount: { type: Number, default: 0 },
    transcript: { type: [TranscriptLineSchema], default: [] }
  },
  { timestamps: true } // createdAt = when it was opened
);

TicketSchema.index({ guildId: 1, status: 1, openerId: 1 });
TicketSchema.index({ guildId: 1, number: -1 });

module.exports = mongoose.model('Ticket', TicketSchema);
