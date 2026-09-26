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
│   │   │                          #   lockdown, reactionRoles, polls, reminders, welcome, joinTracking
│   │   └── utils/                 # permissions.js, duration.js
│   ├── database/
│   │   ├── db.js                  # Mongoose connection
│   │   └── models/                # Giveaway, GuildConfig, UserLevel, Poll, Reminder, ReactionRolePanel,
│   │                              #   MemberJoin, WelcomeConfig
│   └── web/
│       ├── server.js               # Express app, sessions, route mounting, /health
│       ├── routes/                 # auth.js (OAuth2), dashboard.js, api.js, manage.js, embedBuilder.js
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
| `TWITCH_CLIENT_ID` | no | Optional — switches Twitch alerts to the official API (free app at dev.twitch.tv/console/apps) |
| `TWITCH_CLIENT_SECRET` | no | Same app as above |
| `ERROR_ALERT_CHANNEL_ID` | no | A channel (in any server the bot is in) that gets every error with details |
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
`/loof help` is an interactive menu anyone can use: an overview of every category, a dropdown to
browse each category's commands (with 🔒 permission tags), and a link to the web dashboard.

### Honeypot (`/honeypot ...` or the web dashboard)
- `setup` a trap channel — posts a live counter embed there.
- `action` sets the punishment: kick, soft ban (ban+unban to purge messages), or permanent ban.
- Any message posted in the trap channel is deleted and the author is instantly punished;
  the counter embed updates in place.
- Caught members get a **DM first** explaining what happened, the likely cause (a compromised
  account, a self-bot, or a mistake), their punishment, and how to secure their account.
  Turn it off with `/honeypot dm enabled:false` or on the dashboard. `/honeypot toggle` pauses the trap.
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
- **Level name colors** (`/levels colorroles …` or the dashboard's Leveling → Level colors tab, off
  by default): every N levels (default 5, up to level 100) members get a cosmetic, permission-less
  `Level N` role in its own color, created the first time anyone reaches that tier. Members hold
  only their highest tier's color, so their name color changes as they level (and moves back down
  if they lose levels). Placement is configurable: just above @everyone, as high as the bot can
  place it (so it overrides other colored roles), or above a chosen role. Any tier can use one of
  your own roles instead, and auto roles can be recolored. **Sync** gives every member the right
  color from their current level; **Delete auto roles** removes the bot-created ones.
- `/levels card` — members customize their rank card (accent color, background image, tagline).
  `/levels cardaccess boosters_only:true` makes it a booster perk.

### XP Gambling (`/gamble ...` or the dashboard's Gambling tab)
- Every finished game shows the player's updated XP balance and level, win or lose.
- `coinflip` — 50/50, pays `2 × (1 − edge)`.
- `blackjack` — 6-deck shoe, dealer stands on 17, blackjack pays 3:2, double down on the first
  two cards (no splits). The house edge is taken from winnings.
- `mines` — a 5×5 board with 1–24 mines. Every gem multiplies your winnings by
  `tiles left ÷ safe tiles left`; hit a mine and the bet is lost. Cash out any time.
- `highlow` — call whether the next card (A–K) is higher-or-same or lower-or-same. Each correct
  call multiplies winnings by `1 ÷ chance`. You can skip a card, and cash out any time.
- **Free play:** if a loss leaves a player below the minimum bet, they get one free **300 XP** bet
  (their next `/gamble` uses it automatically; they keep any winnings). At most once per 24 hours
  per member so it can't be farmed — amount, cooldown and on/off are on the Gambling page or
  `/gamble config`. A free play interrupted by a restart gives the free play back, not XP.
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
- Logs are stored for 30 days and shown in the dashboard's **Log viewer** (search by user, text or
  channel, filter by event type). Posting to a Discord channel is optional.
- Message edit/delete logs include a **Jump to message** button, and edits highlight exactly what
  changed (~~removed~~ words struck through, added words in bold).
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

### Welcome Messages (dashboard **Welcome** tab)
- Greets every new member in a chosen channel with text, an optional rich embed, or both.
- Placeholders: `{user}` (mention), `{username}`, `{server}`, `{membercount}`; use `{avatar}` as the
  thumbnail URL to show the new member's avatar. Only the new member is ever pinged.
- The tab has a live Discord-style preview and a **Send test** button that posts the current
  form using you as the new member. **Design in Embed Builder** opens the full Embed Builder
  with the welcome message loaded; its **Use as Welcome Message** button saves it back.

### Join Analytics (dashboard **Overview** tab)
- Every join and leave is recorded automatically. The Overview's **Member curve** shows joins,
  leaves and net change per day or week over 7 days to 1 year. Stat cards show week-over-week and
  day-over-day trends, and **Server goals** tracks the next member milestone, how many members
  have earned XP, and progress to the next boost tier.
- Leaves can only be tracked from the moment this feature is deployed (Discord keeps no history).
- **Sync Join Data** backfills history from every current member's join date (members who left
  can't be recovered, and rejoiners only report their latest join). Limited to once per 5 minutes.

### Creator Alerts (`/alerts …` or the dashboard's **Alerts** page)
- Twitch go-live and YouTube upload alerts, each with its own channel, ping role (or @everyone),
  message and embed (placeholders `{name}` `{title}` `{url}` `{game}`), and a pause switch.
- Follow any streamer by pasting their twitch.tv link (or username) — nothing is hard-coded and no
  setup is needed. Twitch is checked every 2 minutes; when a stream ends, its alert is edited to
  "Stream ended · streamed for 2h 5m" without a second ping.
- Without keys the bot uses the public connection twitch.tv's own site uses (unofficial — Twitch
  could change it). Set `TWITCH_CLIENT_ID`/`TWITCH_CLIENT_SECRET` to use the official API instead.
- YouTube uses the channel's public RSS feed every 5 minutes — no API key. Following a channel
  never announces its old videos, and at most 3 new videos are posted per check.
- Alerts in announcement channels are auto-published to followers.

### Daily streaks (`/daily`)
- Claim XP once per UTC day. Consecutive days add a streak bonus (default +10/day, capped at
  +200) and a milestone bonus every 7 days (+250). Configure it on Leveling → 🔥 Daily streaks.
- The streak shows on `/levels rank`. Claims go through normal XP, so role rewards and level
  colors apply.

### Server Settings (dashboard, admins only)
- **Mod access:** pick moderator roles and which pages they can use (e.g. Log viewer and
  Leaderboard only). Mods see a limited dashboard; everything else is hidden and blocked by the API.
- **Bot alerts:** a staff channel where LoofaryBot reports problems it can't fix itself (missing
  permissions, a role above the bot, a deleted channel, errors). Repeats are grouped.
- **Change history:** every dashboard change, who made it (admin or mod) and when — kept 180 days.
- **Backups:** automatic daily backups (last 7) plus manual ones, each with settings and member XP.
  Download any backup, restore it (XP optional), or export/import settings as a JSON file. A safety
  backup is taken before every import or restore.

### Member data
- When someone leaves, their XP/level/rank card, reminders in that server and entries in running
  giveaways are deleted, so they drop off the leaderboard. Anyone who left while the bot was
  offline is cleaned up on the next startup. Anonymous join/leave counts are kept for the charts.

### Web Dashboard
- **Everything works from both places.** Anything a slash command manages can also be done on the
  dashboard, using the same code:
  - **Giveaways:** start timed giveaways or first-to-click drops with every `/loof` option (channel,
    duration, winners, ping, color, button emoji, description, role/days/level requirements) and a
    live preview. Running ones can be edited (including a new end time), ended early, rerolled or deleted.
  - **Reaction Roles:** build role panels (buttons, multi-pick or single-pick dropdown) with a live
    preview, then edit or delete them.
  - **Polls & Reminders:** post polls (anonymous, multiple choice, auto-close) and see live results,
    then close them. Schedule or cancel channel reminders.
  - **Moderation:** lock or unlock a channel or the whole server, and purge messages (optionally from
    one member).
  - **Leaderboard → Adjust a member's XP:** give, take or reset XP (`/levels givexp · takexp · resetxp`).
  - Each of these can be given to dashboard moderators under Server Settings, and every action is
    recorded in the change history.
- **Home page:** open to everyone without logging in. It lists the features, live bot stats, an
  **Add to Discord** button and every command members can use (searchable, click to copy).
- **Server picker:** a searchable card grid of your servers with admin/moderator badges. It also
  lists servers you manage that don't have the bot yet, each with a one-click invite.
- Every module has an on/off switch — in the sidebar, on its Overview card and in its page header.
- Module pages are split into sub-tabs (e.g. Leveling: XP & speed · Role rewards · Multipliers ·
  Level-up messages · Rank cards) with a sticky **Save changes** bar.
- Every text field the bot sends (welcome message/embed, honeypot trap message) supports the same
  `@member`, `@role`, `#channel` and `:emoji:` autocomplete as the Embed Builder.
- Sidebar navigation with module on/off status, a search bar that jumps to any settings page or
  command, and a **Sun / Moon** switch for light or dark theme (remembered per browser).
- Visit the deployed URL → **Login with Discord** → pick a server where you have
  Manage Server/Administrator permission and the bot is present.
- Configure the honeypot (including its disguise), leveling (role rewards, multipliers, level-up
  channel, rank card access), XP gambling and server logs without slash commands.
- **Embed Builder**: a Discohook-style visual editor (title, description, color, fields,
  footer, image/thumbnail) with a live preview and a channel dropdown limited to channels
  the bot can actually post in — click **Send Embed** to publish it live via the bot.

## 7. Notes & Limitations

- Dashboard logins are stored in MongoDB (`web_sessions`), so they survive redeploys. Keep
  `SESSION_SECRET` set to the same long random value — changing it logs everyone out.
- Redeploys and restarts settle open gambling games: winnings are cashed out, otherwise the bet
  is refunded (blackjack hands are always refunded). A crash is caught up on the next startup —
  the bet is refunded and the player is told in the channel.
- Render's free tier has an ephemeral filesystem — this is exactly why giveaways, honeypot
  counts, and level data all live in MongoDB Atlas rather than local files.
