const mongoose = require('mongoose');

const VoteSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true },
    option: { type: Number, required: true }
  },
  { _id: false }
);

const PollSchema = new mongoose.Schema(
  {
    guildId: { type: String, required: true, index: true },
    channelId: { type: String, required: true },
    messageId: { type: String, required: true, unique: true, index: true },
    creatorId: { type: String, required: true },
    question: { type: String, required: true },
    options: { type: [String], required: true },
    anonymous: { type: Boolean, default: false },
    multipleChoice: { type: Boolean, default: false },
    votes: { type: [VoteSchema], default: [] },
    endTimestamp: { type: Number, default: null }, // null = stays open until /poll end
    ended: { type: Boolean, default: false, index: true }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Poll', PollSchema);
