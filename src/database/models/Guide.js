const mongoose = require('mongoose');

// A server guide: one article the bot owns and publishes as a forum post, so editors can update it
// later and the live post edits itself in place. The body is a Discord message ({ content, embeds })
// — the same format the Embed Builder and templates use, so guides import/export cleanly.
const GuideSchema = new mongoose.Schema(
  {
    guildId: { type: String, required: true, index: true },
    // A stable, URL-safe id derived from the title (unique per guild). Used by /guide and the dashboard.
    slug: { type: String, required: true },
    title: { type: String, required: true },
    // Forum tag names this guide is filed under (also mapped to the forum's tag ids when published).
    tags: { type: [String], default: [] },
    // Shown at the top of the pinned index post instead of as a forum post of its own.
    inIndex: { type: Boolean, default: false },
    // The guide body in Discord message JSON ({ content, embeds: [...] }).
    body: { type: mongoose.Schema.Types.Mixed, default: null },

    threadId: { type: String, default: null }, // the forum post (thread) id
    messageId: { type: String, default: null }, // the thread's first message (the one we edit)

    authorId: { type: String, default: null }, // credited author (shown on the guide)
    createdBy: { type: String, default: null }, // who created it in the tool
    editedBy: { type: String, default: null }, // who last edited it
    order: { type: Number, default: 0 } // manual sort within a tag on the legend
  },
  { timestamps: true }
);

GuideSchema.index({ guildId: 1, slug: 1 }, { unique: true });

module.exports = mongoose.model('Guide', GuideSchema);
