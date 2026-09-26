const mongoose = require('mongoose');

const EmbedFieldSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    value: { type: String, required: true },
    inline: { type: Boolean, default: false }
  },
  { _id: false }
);

const EmbedTemplateSchema = new mongoose.Schema(
  {
    guildId: { type: String, required: true, index: true },
    name: { type: String, required: true },
    createdBy: { type: String, required: true },

    content: { type: String, default: '' },
    title: { type: String, default: '' },
    description: { type: String, default: '' },
    color: { type: String, default: '#5865f2' },
    footer: { type: String, default: '' },
    imageUrl: { type: String, default: '' },
    thumbnailUrl: { type: String, default: '' },
    fields: { type: [EmbedFieldSchema], default: [] }
  },
  { timestamps: true }
);

EmbedTemplateSchema.index({ guildId: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('EmbedTemplate', EmbedTemplateSchema);
