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
   The bot needs **Manage Roles** for reaction roles, level rewards and `/lockdown`,
   **Timeout Members** for `/timeout` and auto-mod, **Manage Nicknames** for the XP shop's
   nickname tags, and **View Audit Log** so logs can say who made a change. The invite link on
   the home page asks for all of them. The other gateway intents the bot uses (reactions, bans,
   invites, emoji) don't need switching on.
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

### Daily XP Pot (`/pot …` or dashboard **Gambling → 💰 Daily XP Pot**, off until set up)
- **Filling:** every XP lost in `/gamble` goes into today's pot (100% by default, adjustable). It
  keeps collecting right up to the draw, including during the countdown. Wins and free plays add
  nothing.
- **Countdown:** 10 minutes before the draw (default **00:00 UTC**, the end of the day), the pot is
  posted in your channel with an optional ping. The embed explains how it works and shows:
  - the pot
  - a live countdown
  - how many members are entered so far
  - the **top 3 pot contributors** (the day's biggest losers)

  It refreshes every 30 seconds.
- **Who's entered:** everyone who chatted in the last hour, with no button to press. By default
  that's 3+ messages in the last 60 minutes, and messages must be at least 20 seconds apart, so
  spamming doesn't help. Bots never count. After a restart it falls back to members who earned
  chat XP in that hour.
- **The draw, with tiered prizes:** winners are picked at random from the active members, and the
  first one picked gets the biggest prize. 1st place gets up to the **top prize** (default 3,000 XP),
  and every place after gets at most 70% of the place above, from what's left. There are at most
  **10 winners** (configurable, up to 25), never more than the people entered, and no prize under
  10 XP. Whatever doesn't fit rolls over to tomorrow, so a night never pays out more than about
  9,700 XP with the defaults. Examples:
  - 800 XP pot → 🥇 800.
  - 5,000 XP pot, 3 entered → 🥇 3,000 · 🥈 2,000.
  - 20,000 XP pot, 10+ entered → 🥇 3,000 · 🥈 2,100 · 🥉 1,470 · 1,029 · 720 · 504 · 352 · 246 ·
    172 · 120, and 10,287 rolls over.

  The post turns into the result listing every winner and prize, and a winner message pings them.
- **Pot cap:** the pot holds at most **10,000 XP** (configurable). The moment it's full, it's
  posted and drawn after the usual countdown, whatever the time of day. Losses after that go into
  the next pot, so no pot ever holds more than the cap.
- **Rollovers:** if nobody's active, the pot rolls over to tomorrow. A pot under the minimum
  (default 100 XP) rolls over quietly without being posted, so quiet days stay quiet. A draw missed
  by 12+ hours (bot offline) also rolls over.
- **Who's entered:** `/pot entrants` shows everyone entered right now (with their message count), who's
  almost in, and whether *you* are in. `/pot entrants last:true` shows who was entered in the last
  draw. The dashboard's pot card has the same "Entered right now" list, and each of the Recent pots
  can be expanded to see who was entered.
- **Commands:** `/pot view`, `/pot history` and `/pot entrants` for everyone. For staff:
  - `/pot setup` (channel, draw hour, countdown, messages needed, minimum pot, share, top prize,
    winners, pot cap, ping)
  - `/pot look` (title, text with `{pot}` `{draw}` `{min}` `{window}`, color, images, footer,
    winner message with `{winners}` `{winner}` `{count}` `{pot}` `{prize}` `{rollover}`)
  - `/pot draw` (post now and draw after the countdown, handy for testing)
  - `/pot preview`, `/pot toggle`
- The dashboard has the same settings, a live embed preview, a prize-ladder calculator (type a pot
  size to see the split), the current pot and recent winners.

### XP Gambling (`/gamble ...` or the dashboard's Gambling tab)
- Every finished game shows the player's updated XP balance and level, win or lose.
- `coinflip` — 50/50, pays `2 × (1 − edge)`.
- `dice` — rolls 0.00–99.99. Bet **under** or **over** a target you pick (1–95% chance); pays
  `(1 − edge) × 100 ÷ chance`, e.g. 50% → 1.92x, 10% → 9.60x. The `target` option previews the odds
  and payout as you type.
- `limbo` — pick a target multiplier from 1.01x to 1,000x. The result multiplier reaches your target
  with a `(1 − edge) ÷ target` chance (2x ≈ 48%, 100x ≈ 0.96%); if it does, you win `target × bet`.
- `blackjack` — 6-deck shoe, dealer stands on 17, blackjack pays 3:2, double down on the first
  two cards (no splits). The house edge is taken from winnings.
- `mines` — a 5×5 board with 1–24 mines. **More mines pay more:** every gem multiplies your
  winnings by `tiles left ÷ safe tiles left`. With the default edge, 3 gems pay ×1.09 with 1 mine,
  ×1.43 with 3 mines and ×4.85 with 10 mines. Hit a mine and the bet is lost; cash out any time. The board shows the
  payout ladder for the next few gems, and the `mines` option previews it as you type.
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
- **Daily limit:** members can play **10 games a day** by default (resets at midnight UTC). Every
  result shows how many plays are left. Change it (0 = unlimited) with `/gamble config
  daily_limit:` or the dashboard. A game that fails to start doesn't use a play.
- **`/gamble stats`** shows games played, W/L, win rate, XP wagered, net XP, biggest single win
  (game and multiplier), current, best and worst streaks, and a per-game breakdown — for you or any
  member. `/gamble stats server:true` shows server totals and the top players. The dashboard's
  Gambling page has a Top gamblers table. Refunded games aren't counted.
- **Daily win limit** (default **+1,000 XP** a day, `/gamble config daily_win_cap:` or the dashboard;
  0 = off): the most XP a member can come out ahead from gambling each day, counting wins minus
  losses. A game never pays past what's left of it; mines and high-low cash out automatically when
  they reach it. Once a member hits it, more bets wait until midnight UTC. Without it, a few lucky
  all-in bets could turn 500 XP into level 13 in minutes. `/gamble info` shows each member's plays
  and winnings left today.
- **Max win per game** (optional, `/gamble config max_win:` or the dashboard): caps what one game
  can pay. Mines and high-low cash out automatically when the cap is reached.
- **Dismissed the private controls?** The game keeps going. `/gamble resume` (or the **Show my
  controls** button on the "finish your game" message) brings them back. Left alone, the game ends
  after 3 minutes as below, so nothing is lost.
- An idle game ends after 3 minutes: winnings are cashed out, blackjack auto-stands, and a game
  with nothing won yet is refunded. Restarts settle or refund open games too.
- Others can watch a game live on its public board, but only the player gets working buttons, in a
  private copy of the board.
- Stuck games can't lock anyone out or keep their XP:
  - Game commands answer Discord instantly, so the 3-second reply window can't be missed.
  - If the board still can't be posted, the bet is refunded on the spot.
  - A minute-by-minute sweep ends games whose timer was lost and refunds bets from games that
    vanished, with a notice in the channel.
  - Settling a game "claims" its stored bet, so a stake is never refunded twice, even while the old
    and new copies of the bot overlap during a redeploy.
- **`/gamble sync`** fixes a stuck player on demand: it ends your game now and returns XP from any
  game that didn't finish. Admins with Manage Server can run `/gamble sync everyone:true` for the
  whole server.

### Giveaways: requirements & drops
- Every way of starting one offers the same options: **type** (timed giveaway or first-to-click
  drop), channel, duration, winners, ping (@everyone, @here and/or a role), color, button emoji,
  description, and entry requirements (role, days in the server, XP level).
  - `/loof start` takes them all inline (`type:` picks timed or drop).
  - `/loof create` opens a form (type, channel, prize, duration, winners), then a private setup
    panel with a live preview and buttons for **Description & look**, **Requirements** and **Ping**.
    **Start** stays disabled until everything is valid.
  - The dashboard's **Giveaways** page has the same form, plus **Duplicate** to reuse a past one.
- `/loof edit` changes the prize, winners, end time (`ends_in`), description, color or emoji.
  `/loof requirements` adds, changes or clears requirements. Entrants who no longer qualify are
  skipped at the draw.
- Members who don't meet the requirements can't enter. Clicking **Enter** (or **Claim!**) shows them a
  private ✅/❌ checklist of every requirement, e.g. "❌ Be **Level 5+** (you're Level 3)".
- Discord-managed roles such as **Server Booster** can be picked as a required role, a bonus-entry
  role, an XP-multiplier role or a ping. They're left out of role pickers where the bot would have
  to hand the role out (level rewards, auto-role, reaction roles, birthday role), because Discord
  doesn't allow that.
- Every `message_id` option autocompletes — start typing the prize. Duration options suggest
  common values and show what you typed (e.g. `90m (1h 30m)`).
- `/loof drop` posts a **Claim!** button; the first N members to click win instantly.
- **Bonus entries:** give members with certain roles extra tickets (e.g. Boosters +2 = 3 tickets).
  Their best bonus counts. Set it with `bonus_role`/`bonus_entries` on `/loof start` and
  `/loof edit`, in the `/loof create` Requirements form, or on the dashboard. Draws are weighted
  and fair (cryptographic randomness), and rerolls prefer people who haven't won yet.
- **Entrants:** `/loof entries` or the dashboard's **👥 Entrants** button lists who entered and
  their ticket counts. The dashboard can also remove an entrant.
- Older giveaways created before the type/requirements options existed now open correctly in the
  dashboard's **Edit** and **Duplicate**.

### Moderation & Security
- **Cases:** `/warn`, `/timeout`, `/untimeout`, `/kick`, `/ban` (optionally temporary, by user ID,
  with message deletion) and `/unban` each create a numbered case. The member is DM'd the reason
  (turn off with `/cases dm`), and the action is logged under the new *Moderation actions* log
  event. The bot refuses actions on the owner, admins (timeouts), yourself, or anyone at or above
  your top role. Temporary bans are lifted automatically.
- `/cases user|recent|view|reason|revoke|delete` browses and edits the history. Revoked warnings
  stay on record but stop counting.
- **Warning escalation:** `/cases escalation add warnings:3 action:kick` (or timeout/ban with a
  duration). At that many active warnings the action happens automatically.
- `/slowmode interval:30s` (or `off`) for a channel.
- Dashboard **Moderation** page: a *Cases* tab to take action and search, revoke, edit or delete
  cases; plus *Lockdown & purge*, *Media-only* and *Escalation & DMs* tabs.
- **Auto-mod** (`/automod` or dashboard **Moderation → Auto-mod**, off until you turn it on). It
  catches spam without punishing fast typers:
  - 🌊 **Message spam:** 7+ messages in 5 seconds.
  - 🔁 **Repeated messages:** the same text 4 times in 30 seconds, ignoring case and spaces.
  - 🧱 **Text walls:** the same line or word over and over, "aaaaaa…", or 30+ lines. Code blocks are fine.
  - 📣 **Mention spam:** 5+ people or roles in one message, or trying @everyone/@here without
    permission.
  - 🔗 **Invites to other servers.** Invites to your own server are fine.
  - 🌐 **Link spam** and 🔠 **caps spam:** optional, off by default.

  Offending messages are deleted and the member gets a strike. By default that's **2 warnings,
  then a 1 hour timeout**, and a short notice ("Warning 1/2") deletes itself after 8 seconds.
  - One burst of spam counts as one strike.
  - Strikes are forgotten after 24 hours, and a mute starts the count over.
  - Staff (Manage Messages) and exempt roles or channels are never checked.
  - Every catch is a numbered case and is logged.

  All thresholds, the number of warnings and the mute length can be changed.
- **Logs cover everything** (each type can be switched off):
  - message edits, deletes and purges (with a transcript)
  - joins and leaves
  - voice activity
  - role changes
  - nicknames, timeouts, boosts and server avatars
  - bans and unbans made anywhere
  - channels, server roles (with permission changes) and threads
  - invites, and emoji and stickers
  - server settings
  - slash commands used
  - moderator actions, auto-mod catches and shop purchases

  When the bot has View Audit Log, entries say who made the change.
- **Storage:** the dashboard's **Log viewer** keeps history for 30 days by default (7, 14, 30, 60 or
  90 under **Logs → Settings → Storage**). A server also keeps at most **20,000 entries**, the newest,
  so a busy day can't flood the database. Older entries are deleted every hour, or right away with
  **Clean up now**. Also cleaned automatically:
  - finished chat drops after 30 days
  - ended polls after 90 days
  - ended giveaways after 180 days
  - ticket transcripts 180 days after the ticket closes (the ticket stays in History)

  Posting logs to a Discord channel is optional.
- Message edit/delete logs include a **Jump to message** button, and edits highlight exactly what
  changed (~~removed~~ words struck through, added words in bold).
- `/logs set #channel` — logs message edits/deletes, member joins/leaves, voice joins/leaves/moves,
  and role changes. `/logs toggle` switches individual event types; also on the dashboard's Logs tab.
- `/lockdown scope:channel|server` — denies Send Messages (and thread creation/posting) for
  @everyone and any non-staff role that explicitly allowed it. Roles with Administrator or
  Manage Messages keep talking. `/unlockdown` restores every permission exactly as it was.
  The honeypot channel is left alone.
- `/mediaonly add #channel` (or dashboard → Moderation → Media-only channels) — posts without an
  attachment are removed with a short notice that deletes itself (one per member every 20
  seconds). Options: links count as media (default on), a comment thread on every post, and
  whether staff (Manage Messages) can post anything. Chat inside threads is always allowed.
  `/mediaonly remove` and `/mediaonly list` manage them. Removed posts don't earn XP.

### Tickets (`/ticket …` or the dashboard's **Tickets** page)
- `/ticket setup channel:#support` posts a panel with an **Open a ticket** button. Options (all also on
  the dashboard, with a live preview): the category tickets are created in, up to 3 support roles (10
  on the dashboard), channel names (`ticket-0001`, `ticket-username`, `username-0001` or your own with
  `{number}`/`{username}`), open tickets per member (default 1), asking members what they need first,
  the welcome message inside tickets, and the panel's title, text, color, thumbnail, banner, footer and
  button label / color / emoji. Saving again updates the panel in place.
- **Locked down by default:**
  - The panel channel is **button-only**: members can see the panel and click the button, but can't
    send messages, react or start threads there.
  - The ticket category is **hidden** from everyone except support roles and admins.
  - Each ticket can only be seen and talked in by the member who opened it, the support roles and
    administrators (plus LoofaryBot); nobody can start threads inside it.
  - These permissions are re-applied whenever ticket settings are saved or the panel is posted, which
    also repairs tickets whose permissions were loosened by hand or whose support roles changed.
  - Both locks can be turned off (`/ticket setup lock_panel_channel:false hide_category:false` or the
    dashboard). Only administrators and the support roles count as support. It starts with a welcome message and **🔒 Close · 📌 Claim · 🔔 Ping user**
  buttons. Claiming shows who's handling it; `/ticket add · remove · rename` manage it.
- **Closing** (button, `/ticket close`, or the dashboard) asks for an optional reason, then: DMs the
  member *"Your ticket #12 in Server has been closed by Staff. Reason: …"*, saves a transcript, posts
  a summary + `.txt` transcript to an optional log channel, and deletes the channel after a countdown
  (5 seconds by default). Only the member who opened it or support can close a ticket.
- The dashboard page has **Open tickets** (claimed by, jump to channel, close), **Setup & panel**
  and a searchable **History** of closed tickets with their transcripts (view or download).
- Turn the whole system on/off with its sidebar switch or `/ticket toggle`. Ticket channels deleted
  by hand are marked closed automatically.

### Community Tools
- `/reactionrole create` posts a role panel (buttons, multi-pick dropdown, or pick-one dropdown);
  `add`/`remove` roles by the panel's message ID (up to 25 roles).
- `/poll create question:"…" options:"A | B | C"` with optional `duration`, `anonymous`, and
  `multiple`. Public polls list who voted; anonymous ones show counts only. `/poll end` closes early.
- `/remind me in:2h message:…` (DM, falling back to the channel if DMs are closed),
  `/remind channel …`, `/remind list`, `/remind cancel`. Reminders and timed polls are stored in
  MongoDB and survive restarts.

### Welcome & Goodbye Messages (dashboard **Welcome** tab, `/welcome`, `/goodbye`)
- `/welcome set|toggle|test|show` and `/goodbye …` manage the channel, text and on/off from Discord.
  The dashboard's **🚪 Goodbye** tab posts a message when someone leaves (same placeholders,
  optional embed, nobody is pinged).
- Fixed: auto-role no longer switches itself off for servers set up before the on/off option existed.
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

### Chat drops (`/xpdrop …` or dashboard **Leveling → Chat drops**)
- Fully automatic: every 30–90 minutes (random, configurable) LoofaryBot posts **🎁 XP Drop!** with a
  **Claim** button in one of your chosen channels. The first to click wins a random **50–250 XP**
  (configurable, rounded to 5).
- Usually one winner; sometimes 2 (22%) or 3 (8%). Each winner gets the full amount.
- When it's claimed, the drop closes and a one-line congrats is posted in the same channel without
  pinging anyone. Drops nobody claims within the window (default 2 minutes) are deleted quietly.
- Drops only land in channels people are actually chatting in (default: 3+ messages in the last 10
  minutes, bots don't count). Quiet channels wait until someone talks.
- Only one drop is open at a time, claims are atomic (a click race gives exactly the right number of
  winners), and drops survive restarts. Nothing happens while leveling is off.
- `/xpdrop setup` (channels, XP range, timing, activity, claim window) · `now` · `status` · `toggle`.

### XP Shop (`/shop …` or the dashboard's **XP Shop** page)
Members spend XP on fun extras. The shop is open by default and comes with starter items:

| Item | Price | What it does |
| --- | --- | --- |
| ✨ Auto-react | 2,500 XP | LoofaryBot reacts to your messages (at most every 45s) with **your** emoji. Toggle it on/off. |
| ⚡ XP Boost (24h) | 1,500 XP | +50% chat XP for 24 hours. Buying again adds another 24 hours. |
| 🎲 +3 Gambles | 800 XP | Three extra `/gamble` plays today. |
| 🏷️ Nickname tag | 1,200 XP | An emoji of your choice in front of your name. Toggle it off and your old nickname comes back. |
| 🎖️ Custom badge | 3,000 XP | Fully yours: your **title, emoji and color** on `/levels rank` and the leaderboard. |
| 🏆 Golden Loofa | 10,000 XP | A collectible trophy for your rank card. Only 10 exist. |

- **Using the shop:** `/shop view` shows the shop with a buy menu. `/shop buy`, `/shop inventory`,
  `/shop toggle` and `/shop customize` (emoji, badge title, badge color) cover the rest.
- **Safe payments:** XP is taken atomically, so a member can't overspend, and limited stock can't
  oversell. If an item can't be delivered (for example a role above the bot), the XP is refunded.
- **Dashboard:** edit, hide, reorder or delete any item, or add your own of any kind. Each item can
  have:
  - a **role** (optionally temporary, e.g. VIP for 24h)
  - collectibles, boosts with any multiplier and length, or extra gambles
  - stock, a limit per member and a minimum level

  Roles with Administrator or Manage Server can't be sold. The **Member items** tab shows what
  someone owns, and lets you **give** items for free or **take one away**. **Recent purchases** and
  totals are shown too, and every purchase is logged.
- Spending XP lowers XP (and possibly level), just like gambling. Role rewards already earned are kept.

### Birthdays (`/birthday …` or dashboard **Engagement → Birthdays**)
- Members save their birthday with `/birthday set` (month and day only, no year).
- Once a day, at the hour you pick (UTC, default 14:00), LoofaryBot posts **one** message wishing
  everyone whose birthday it is. The message is customizable with `{users}`, `{count}` and `{server}`.
- Optional extras: a **birthday role** for the day (taken back after 24 hours) and an **XP gift**.
- Feb 29 birthdays are celebrated on Feb 28 in other years. Members who left and bots are skipped,
  and the post never repeats on the same day, even after a restart.
- `/birthday upcoming` and the dashboard list the next birthdays.

### Counting (`/counting …` or dashboard **Engagement → Counting**)
- Members count up one number at a time in a counting channel. Right numbers get ✅, every 100 gets
  💯, and the number that beats the best run gets 🏆.
- A wrong number, or counting twice in a row (with **take turns** on), resets the count to 0 with a
  short message. If two people send the same right number at the same moment, the slower one gets 👀
  instead of a reset.
- Sums like `3*4` count when **allow sums** is on. Messages that don't start with a number are
  ignored, so people can still chat. If someone deletes the latest count, the bot posts the next number.
- `/counting set` (or the dashboard) fixes the count after an unfair reset.

### Starboard (`/starboard …` or dashboard **Engagement → Starboard**)
- Messages with enough ⭐ (default 3, or your own emoji) are reposted in the starboard channel with
  the text, the first image and a jump link.
- The star count on the post keeps updating (🌟 at 10+, 💫 at 25+). If stars drop below the
  threshold the post is removed, and deleting the original removes the copy too.
- Stars from the author (unless allowed) and bots don't count. NSFW channels never feed a non-NSFW
  starboard, and you can ignore channels. Threads follow their parent channel.

### Booster perks (`/perks` or dashboard **Leveling → Booster perks**)
Server boosters get, by default:
- 🎲 **+5 gambles a day** on top of the daily gamble limit.
- 🎁 **+2 entries in every timed giveaway** (their best bonus counts if they also have a bonus role).
- 📦 **100 XP every day, automatically**, sent just after midnight UTC. Optionally announced in a
  channel, without pings.
- 💝 **A 500 XP thank-you package** when they boost, with a DM listing their perks. Once per 30 days,
  so unboosting and reboosting can't farm it.

`/perks show` lists them for anyone. `/perks config` (Manage Server) or the dashboard changes every
amount, the announcement channel, or turns them off.

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
- **Embed Builder**: a Discohook-style editor for messages with up to 10 embeds, each with
  author, title and link, description, color, up to 25 fields, image, thumbnail, footer and
  timestamp. The live preview matches Discord's layout, including inline fields (3 per row, or
  2 next to a thumbnail) and headings, quotes, lists, spoilers and links. Fields and embeds can
  be reordered and duplicated; each embed shows a live 6,000-character counter.
  - **Templates are saved in Discord's own JSON format** (`{ content, embeds }`), so they move
    freely between LoofaryBot, Discohook and webhooks. Older templates are converted when loaded.
  - **Import:** paste JSON or pick a file. Accepted: Discohook's JSON editor, a Discohook backup
    file (every message becomes a template), a webhook payload, a single embed, an old Discohook
    `?data=` share link, or a LoofaryBot export. Imported messages can be opened in the editor or
    saved as templates. Name clashes are renamed unless **Overwrite** is on.
  - **Export:** download or copy the current message's JSON, or download every template at once.
  - **Clear all** starts a new message from scratch. Drafts autosave in your browser and come
    back after a refresh. <kbd>Ctrl</kbd>+<kbd>S</kbd> saves the loaded template.
  - **Edit a bot message:** paste a message link to update something LoofaryBot already posted,
    or copy any message in the server into the editor.

## 7. Staying inside the free tiers

LoofaryBot is built to run for a long time on **MongoDB Atlas M0** (512 MB storage, ~100
operations/second) and **Render's free web service** (512 MB RAM):
- **Database size:**
  - Log history has a time limit *and* a per-server entry cap (above).
  - Finished drops, polls, giveaways and old ticket transcripts are cleaned up.
  - Old backups are pruned (7 daily and 10 others per server).
  - Dashboard change history expires after 180 days.
  - An hourly **watchdog** checks the database size. Past **75% of 512 MB** it trims harder, stores
    only moderation logs until there's room again (the Discord log channel still gets everything),
    and posts one alert a day in the bot-alerts channel.
  - **Logs → Settings → Storage** shows the database and memory usage against the free limits.
- **Database load:**
  - Server settings are cached for up to 30 seconds on the chat path. Any change from the dashboard
    or a command clears the cache immediately.
  - Chat XP skips re-reading records it just wrote.
  - Together these take a chat message from ~5 database operations to ~2.
  - The connection pool is capped at 10.
- **Memory:**
  - Discord's message cache is limited to 100 messages per channel, and messages older than 6 hours
    are swept hourly.
  - Presences aren't cached.
  - All in-memory helpers (spam tracking, cooldowns, caches) are size-limited and cleaned up.
- **Uptime:** keep UptimeRobot pinging `/health` so the free instance doesn't sleep. One service
  running 24/7 uses ~744 of Render's 750 free hours a month, so don't run a second free service on
  the same account.
- **If you upgrade:** set `DB_STORAGE_LIMIT_MB`, `RAM_LIMIT_MB` or `LOG_MAX_ENTRIES` to match the new plan.

See **[TESTING.md](TESTING.md)** for a step-by-step checklist to verify everything after deploying.

## 8. Tests

```bash
npm install
npm test                # every test file (about 40 seconds)
npm test -- tickets     # only files whose name contains "tickets"
```

The tests in `test/` run each feature's real code against stubbed Discord objects and an in-memory
stand-in for MongoDB, so they need no bot token, database or network. MongoDB update pipelines are
evaluated with [mingo](https://github.com/kofrasa/mingo) (a dev dependency), so the actual `$cond`,
`$ifNull`, `$max`… operators are exercised. Each file runs in its own process; any database call a
test didn't stub fails immediately instead of hanging.

## 9. Notes & Limitations

- Dashboard logins are stored in MongoDB (`web_sessions`), so they survive redeploys. Keep
  `SESSION_SECRET` set to the same long random value — changing it logs everyone out.
- Redeploys and restarts settle open gambling games: winnings are cashed out, otherwise the bet
  is refunded (blackjack hands are always refunded). A crash is caught up on the next startup —
  the bet is refunded and the player is told in the channel.
- Render's free tier has an ephemeral filesystem — this is exactly why giveaways, honeypot
  counts, and level data all live in MongoDB Atlas rather than local files.
