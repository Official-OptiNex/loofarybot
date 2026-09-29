const mongoose = require('mongoose');

// A message that reached the starboard: the original message and the bot's copy in the starboard channel.
const StarboardPostSchema = new mongoose.Schema(
  {
    guildId: { type: String, required: true },
    channelId: { type: String, required: true },
    messageId: { type: String, required: true },
    authorId: { type: String, default: null },
    starMessageId: { type: String, default: null }, // null while the post is being created
    starChannelId: { type: String, default: null },
    stars: { type: Number, default: 0 }
  },
  { timestamps: true }
);

StarboardPostSchema.index({ guildId: 1, messageId: 1 }, { unique: true });
StarboardPostSchema.index({ guildId: 1, stars: -1 });

module.exports = mongoose.model('StarboardPost', StarboardPostSchema);
