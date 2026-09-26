# 🎁 LoofaryBot v2

A modular Discord.js v14 bot with persistent giveaways, an anti-raid honeypot, a leveling
system, and a web dashboard with Discord OAuth2 login and a Discohook-style embed builder.
Built for 24/7 free hosting on Render, kept alive with UptimeRobot, and backed by a free
MongoDB Atlas cluster so nothing is lost on redeploy.

---

## 1. Project Layout

```
LoofaryBot/
├── index.js                     # Entry point — connects DB, logs in bot, starts web server
├── src/
│   ├── config.js                # Loads & validates all environment variables
│   ├── bot/
│   │   ├── client.js             # Discord.js Client + intents
│   │   ├── commands/             # one file per slash command (/loof, /levels, /gamble, /logs, …)
│   │   ├── events/                # ready, interactionCreate, messageCreate
│   │   ├── cogs/modules/          # core logic: giveaways, leveling, honeypot, gambling, logging,
│   │   │                          #   lockdown, reactionRoles, polls, reminders
│   │   └── utils/                 # permissions.js, duration.js
│   ├── database/
│   │   ├── db.js                  # Mongoose connection
│   │   └── models/                # Giveaway, GuildConfig, UserLevel, Poll, Reminder, ReactionRolePanel
│   └── web/
│       ├── server.js               # Express app, sessions, route mounting, /health
│       ├── routes/                 # auth.js (OAuth2), dashboard.js, api.js, embedBuilder.js
│       ├── views/                  # EJS templates
│       └── static/                 # CSS
```

## 2. Environment Variables

Copy `.env.example` to `.env` for local dev, or set these in Render's dashboard.
**`TOKEN` and `CLIENT_ID` are unchanged from the original bot** — no need to regenerate them.

| Variable | Required | Notes |
| :--- | :--- | :--- |
| `TOKEN` | ✅ | Discord bot token (unchanged) |
| `CLIENT_ID` | ✅ | Discord application ID (unchanged) |
| `MONGODB_URI` | ✅ | MongoDB Atlas connection string — see §3 |
| `CLIENT_SECRET` | for dashboard login | Discord application client secret |
| `REDIRECT_URI` | for dashboard login | e.g. `https://your-app.onrender.com/auth/discord/callback` |
| `SESSION_SECRET` | for dashboard login | Any long random string |
| `PORT` | no | Render sets this automatically |

Without `CLIENT_SECRET`/`REDIRECT_URI`/`SESSION_SECRET`, the bot and giveaways/honeypot/leveling
all still work fine — only the OAuth2 web login is disabled until you add them.

## 3. Free Database Setup (MongoDB Atlas)

MongoDB Atlas's free "M0" shared cluster **does not get shut down for inactivity** — it's the
right choice here for a durable, never-expiring free tier (unlike some serverless free tiers
that pause after inactivity).

1. Go to https://www.mongodb.com/cloud/atlas/register and create a free account.
2. Create a new **free M0 cluster** (any region close to your Render region).
3. **Database Access** → add a database user with a username/password.
4. **Network Access** → add IP `0.0.0.0/0` (allow from anywhere) since Render's IPs aren't static.
5. **Database** → **Connect** → **Drivers** → copy the connection string, which looks like:
   ```
   mongodb+srv://<user>:<password>@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
   ```
6. Add a database name to the path (e.g. `.../loofarybot?retryWrites=...`) and paste the
   whole string as `MONGODB_URI`.

No manual schema setup needed — Mongoose creates collections automatically on first write.

## 4. Discord Application Setup

1. In the [Discord Developer Portal](https://discord.com/developers/applications), open your
   existing LoofaryBot application.
2. **Bot** tab → enable **Message Content Intent** and **Server Members Intent** (both are
   required: message content for the honeypot/leveling message listener, members for
   kick/ban/role actions and join/leave logs).
   The bot needs **Manage Roles** for reaction roles, level rewards and `/lockdown`, and
   **View Audit Log** if you want role-change logs to say who made the change.
3. **OAuth2** tab → copy the **Client Secret** into `CLIENT_SECRET`.
4. **OAuth2 → Redirects** → add `https://your-app.onrender.com/auth/discord/callback` (and a
   `http://localhost:3000/auth/discord/callback` entry too if testing locally), matching
   whatever you set as `REDIRECT_URI`.

## 5. Deploying to Render

1. Push this repo to GitHub.
2. Render → New → Web Service → connect the repo.
3. Build command: `npm install`. Start command: `npm start`.
4. Add all the environment variables from §2 in Render's **Environment** tab.
5. Once deployed, point **UptimeRobot** (or any pinger) at `https://your-app.onrender.com/health`
   on a 5-minute interval to keep the free instance awake.

## 6. Features

### Giveaways (`/loof ...`)
Same subcommands as before (`start`, `create`, `end`, `reroll`, `delete`, `list`, `edit`, `ping`,
`help`) — now persisted in MongoDB instead of a local JSON file, and automatically rescheduled
on every restart/redeploy so no giveaway is ever lost or silently skipped.

### Honeypot (`/honeypot ...` or the web dashboard)
- `setup` a trap channel — posts a live counter embed there.
- `action` sets the punishment: kick, soft ban (ban+unban to purge messages), or permanent ban.
- Any message posted in the trap channel is deleted and the author is instantly punished;
  the counter embed updates in place.
- `embed` opens an editor to disguise the trap message (title, text, color, footer, image,
  and whether the kick/ban counters show). Also editable with a live preview on the dashboard.

### Leveling (`/levels ...` or the web dashboard)
- XP is awarded per message (15–25 XP, 60s cooldown — tune in `src/config.js`).
- `/levels rank`, `/levels leaderboard` for users.
- `/levels setrole <level> <role>` (Admin) to configure automatic role rewards.
- `/levels toggle` (Admin) to turn XP gain on/off.
- `/levels announcechannel [channel]` (Admin) to send level-up messages to a specific channel;
  run it with no channel to go back to posting in the same channel the member was chatting in.
  Also configurable on the dashboard's Leveling tab.
- `/levels multiplier add|remove|list` (Admin) — XP multipliers per channel or role. A message
  earns base XP × the channel's multiplier × the member's best role multiplier
  (e.g. `0` in a bot-spam channel, `2` for Server Boosters).
- `/levels givexp`, `/levels takexp`, `/levels resetxp` (Admin) — manual adjustments. Giving XP
  grants any role rewards crossed; taking XP lowers the level but keeps earned roles.
- `/levels card` — members customize their rank card (accent color, background image, tagline).
  `/levels cardaccess boosters_only:true` makes it a booster perk.

### XP Gambling (`/gamble ...` or the dashboard's Gambling tab)
- `coinflip` — 50/50, pays `2 × (1 − edge)`.
- `mines` — a 5×5 board with 1–24 mines. Every gem multiplies your winnings by
  `tiles left ÷ safe tiles left`; hit a mine and the bet is lost. Cash out any time.
- `highlow` — call whether the next card (A–K) is higher-or-same or lower-or-same. Each correct
  call multiplies winnings by `1 ÷ chance`. You can skip a card, and cash out any time.
- The **house edge** (default 4%) is taken once from every payout, so every bet returns 96% on
  average whatever strategy is used. Admins set the edge, min/max bet, and an optional
  gambling-only channel with `/gamble config`. Bets are taken atomically up front, so the same
  XP can't be spent twice.
- Interactive games live in memory: an idle game is auto-cashed out after 3 minutes (or refunded
  if nothing was revealed yet). A bot restart mid-game loses that game's bet.

### Giveaways: requirements & drops
- `/loof start` accepts `required_role`, `min_days` and `min_level`; `/loof requirements` adds,
  changes or clears them on a running giveaway. Entrants who no longer qualify are skipped at the draw.
- `/loof drop` posts a **Claim!** button; the first N members to click win instantly.

### Moderation & Security
- `/logs set #channel` — logs message edits/deletes, member joins/leaves, voice joins/leaves/moves,
  and role changes. `/logs toggle` switches individual event types; also on the dashboard's Logs tab.
- `/lockdown scope:channel|server` — denies Send Messages (and thread creation/posting) for
  @everyone and any non-staff role that explicitly allowed it. Roles with Administrator or
  Manage Messages keep talking. `/unlockdown` restores every permission exactly as it was.
  The honeypot channel is left alone.

### Community Tools
- `/reactionrole create` posts a role panel (buttons, multi-pick dropdown, or pick-one dropdown);
  `add`/`remove` roles by the panel's message ID (up to 25 roles).
- `/poll create question:"…" options:"A | B | C"` with optional `duration`, `anonymous`, and
  `multiple`. Public polls list who voted; anonymous ones show counts only. `/poll end` closes early.
- `/remind me in:2h message:…` (DM, falling back to the channel if DMs are closed),
  `/remind channel …`, `/remind list`, `/remind cancel`. Reminders and timed polls are stored in
  MongoDB and survive restarts.

### Web Dashboard
- Visit the deployed URL → **Login with Discord** → pick a server where you have
  Manage Server/Administrator permission and the bot is present.
- Configure the honeypot (including its disguise), leveling (role rewards, multipliers, level-up
  channel, rank card access), XP gambling and server logs without slash commands.
- **Embed Builder**: a Discohook-style visual editor (title, description, color, fields,
  footer, image/thumbnail) with a live preview and a channel dropdown limited to channels
  the bot can actually post in — click **Send Embed** to publish it live via the bot.

## 7. Notes & Limitations

- Web sessions use in-memory storage and reset on redeploy (you'll just need to log back in);
  swap in `connect-mongo` in `src/web/server.js` if you want sessions to persist too.
- Render's free tier has an ephemeral filesystem — this is exactly why giveaways, honeypot
  counts, and level data all live in MongoDB Atlas rather than local files.
