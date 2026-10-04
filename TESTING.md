# LoofaryBot — what to test after deploying

Work through this after merging and deploying. Each box is a quick check in Discord or on the dashboard.
Use a **second account** (or a friend) for anything marked 👤. That account should have no
staff roles, because staff skip auto-mod and can see everything.

## 0. Before you start
- [ ] Render shows the deploy as **Live**, and the logs show `LoofaryBot logged in as …` and
      `Successfully registered slash commands.`
- [ ] Discord shows the new commands. If one is missing, restart Discord (Ctrl+R).
      New: `/automod`, `/shop`, `/pot`, `/birthday`, `/counting`, `/starboard`.
- [ ] **Role position:** in Server Settings → Roles, drag LoofaryBot's role **above** every role it
      hands out (level rewards, auto-role, birthday role, shop roles, reaction roles) and above
      members it should moderate. Administrator gives the bot every *permission*, but Discord still
      won't let it change anyone or any role **above** its own role.
- [ ] UptimeRobot still pings `https://<your-app>.onrender.com/health` every 5 minutes (keeps the free
      instance awake).

## 1. Giveaway entries (the OG +1 / booster +2 report)
Set up a timed giveaway with **bonus role OG +1**. Keep **Leveling → Booster perks → extra giveaway
entries** at 2.
- [ ] 👤 Member with **neither** OG nor boost clicks Enter → "🎉 You entered the giveaway!" (1 entry).
- [ ] Member with **OG only** → "2 entries (1 + 1 from @OG)".
- [ ] Member who **boosts** (no OG) → "3 entries (1 + 2 from 💎 boosting)".
- [ ] Member with **OG and boost** → "3 entries" (the best bonus counts, bonuses don't add up).
- [ ] `/loof entries` and the dashboard **👥 Entrants** list show the same numbers and *why*
      (e.g. "3 tickets · +2 boosting").
- [ ] If someone gets more than you expect, the "why" names the role giving it. Check that role
      isn't one everybody has (e.g. a "Member" role).
- [ ] Requirements: add "Level 5+". A 👤 member below level 5 clicks Enter → private ✅/❌ checklist,
      not entered.

## 2. Server Booster role on the dashboard
- [ ] Giveaways → bonus entries / requirement role: **Server Booster** is in the list.
- [ ] Leveling → XP multipliers (role): Server Booster is in the list.
- [ ] Auto-role, level rewards, reaction roles, birthday role, shop role items: Server Booster is
      **not** offered (Discord doesn't let bots give it).

## 3. Auto-mod (Moderation → Auto-mod, or `/automod toggle enabled:true`)
Turn it on first. The defaults are fine.
- [ ] 👤 Chat normally and fairly fast (5–6 different messages quickly) → nothing happens.
- [ ] 👤 Send 7+ messages within 5 seconds → they're deleted, and a notice "Warning 1/2" appears then
      disappears after ~8s.
- [ ] 👤 Wait 15s, then send the same message 4 times → deleted, "Warning 2/2 — next time is a 1h mute".
- [ ] 👤 Wait 15s, then post `discord.gg/somethingelse` → deleted and **timed out for 1 hour**.
      Remove the timeout (right-click → Remove Timeout) when done.
- [ ] 👤 Post an invite to **your own** server → allowed.
- [ ] 👤 Mention 5 people in one message → deleted, and a strike is given.
- [ ] Your staff account does the same things → nothing happens (staff skip auto-mod).
- [ ] Moderation → Cases shows the auto-mod warnings and timeout as numbered cases, and **Recent
      catches** lists them.
- [ ] `/automod status` shows the rules and recent catches.
- [ ] **Unsafe links** (on by default with auto-mod):
  - [ ] 👤 Post `https://www.youtube.com/watch?v=dQw4w9WgXcQ` and `https://github.com` → they stay.
  - [ ] 👤 Post `https://bit.ly/3xyz` → removed with a warning ("that link was removed — it doesn't
        look safe").
  - [ ] 👤 Wait 15s, then post `https://discord-nitro.gift/claim` → removed and **muted straight
        away** (scam link). Remove the timeout afterwards.
  - [ ] 👤 Post "hi", then edit it to `hi https://steamcommunlty.com/gift` → the edited message is
        removed too.
  - [ ] 👤 Post `https://pornhub.com` (or any adult site) → removed with a 🔞 "adult (NSFW) links
        aren't allowed here" note and a warning. In a channel marked **Age-Restricted (NSFW)** in
        Discord, the same link stays. `/automod checklink url:somesite.xxx` → "an adult (NSFW) site".
  - [ ] `/automod checklink url:dlscord.com` → "would be removed — a misspelled copy of discord".
        The dashboard's **Test a link** gives the same answer.
  - [ ] `/automod links mode:Every link except approved sites allow:example.com`, then 👤 post
        `https://example.com` (stays) and `https://randomblog.net` (removed with a short note and
        no strike). Switch back with `/automod links mode:Only unsafe links`.

## 4. Logs (Logs → Settings)
Set a log channel if you want to see them in Discord, too.
- [ ] Change someone's nickname → "Nickname changed … Before/After (By …)".
- [ ] Create, rename and delete a test channel → three log entries, each naming who did it.
- [ ] Create a role, give it a permission, delete it → logs with the permission change.
- [ ] `/purge` a few messages → one "N messages deleted" log with a transcript in the log viewer.
- [ ] Ban and unban a test account (or use Discord's own ban menu) → ban/unban logs.
- [ ] Create an invite → invite log.
- [ ] Run any slash command → "used /…" in the log viewer.
- [ ] Switch a type off (e.g. *Slash commands used*), save, run a command → no new entry.
- [ ] **Storage card:** shows stored entries, the max (20,000), and **Database** and **Bot memory**
      bars against the free limits. **🧹 Clean up now** works.

## 5. XP Shop (`/shop view`, dashboard **XP Shop**)
Give your 👤 test account XP first: dashboard Leaderboard → Adjust XP, e.g. +20,000.
- [ ] `/shop view` lists 6 starter items. Pick one from the menu → confirm → bought. XP goes down.
- [ ] Buying something you can't afford → "costs X XP — you have Y", and nothing is taken.
- [ ] **Auto-react:** buy it, chat → the bot reacts 🔥 (at most every ~45s).
      `/shop customize item:Auto-react emoji:🍕` changes it. `/shop toggle` turns it off/on.
- [ ] **Nickname tag:** buy it → your name gets "⭐ " in front. Customize the emoji → it updates.
      Toggle off → your old nickname comes back.
- [ ] **Custom badge:** buy it, then `/shop customize item:Custom badge title:Night Owl emoji:🦉
      color:#FF00AA` → `/levels rank` shows "🦉 **Night Owl**" and `/levels leaderboard` shows it next
      to your name.
- [ ] **XP boost:** buy it → `/shop inventory` shows "active until …". Chat XP is 1.5× for 24h.
- [ ] **+3 gambles:** use up today's `/gamble` plays, buy it → you can play 3 more.
- [ ] **Golden Loofa:** shows "N left", and `/levels rank` shows it under *Collection* after buying.
- [ ] Dashboard: edit an item's price → `/shop view` shows the new price. Hide an item → it
      disappears from `/shop`.
- [ ] Dashboard: **Add item → Role**, pick a role, 24 hours, price 100 → buy it → you get the role.
      `/shop toggle` hides/shows it. It's removed automatically after 24h.
- [ ] Dashboard: **Member items** → search your test account → **Give for free** and **Take away**
      both work.
- [ ] Dashboard: **Recent purchases** lists what was bought, and Logs has *XP shop purchases*.

## 5b. Bubble Factory idle game (`/idle`, dashboard **Leveling → 🫧 Bubble Factory**)
Turn it on first (dashboard Leveling tab, or it's off by default).
- [ ] `/idle play` → a clean factory embed: a **Ready to collect** progress bar, a "next upgrade"
      nudge, Bank / Production / Storage / Cash out / Lifetime / Upgrades fields, and
      **Collect / Upgrades / Cash out → XP / Refresh** buttons. The bar is > 0 after some time has
      passed (opening does **not** auto-collect).
- [ ] Press **Refresh** → the bank stays the same and the collect bar keeps growing — bubbles only
      move to the bank when you press **Collect**.
- [ ] Press **Collect** → a short bubble animation, then your bank goes up and **To collect** resets to 0.
- [ ] **Upgrades** → buy 🧽 Scrubber → your rate goes up; a buy you can't afford is refused, no change.
      With uncollected bubbles waiting, the Upgrades view shows a "← Back, then Collect" hint and only
      your collected bank is spendable.
- [ ] Earn/collect enough, then **Cash out → XP** → your XP goes up (check `/levels rank`), up to the
      daily cap. Cashing out again after the cap → "you've hit today's cap".
- [ ] Set **Daily XP cap** to 0 on the dashboard → the Cash out button is disabled (bubbles only).
- [ ] Someone else clicking your factory's buttons → "that's someone else's factory".
- [ ] `/idle top` and the dashboard's **Biggest factories** list the same people.
- [ ] **Staff:** `/idle admin toggle enabled:false` turns it off (non-staff get "needs Manage Server").
      `/idle admin give @user amount:500` adds 500 🫧 to their bank; `/idle admin take @user amount:200`
      removes 200; `/idle admin reset @user` wipes their factory. Each replies with the new balance.
- [ ] Dashboard: the 🫧 header bubbles animate; the **At these settings** preview tiles update live as
      you change a number (before saving); the **Upgrade tree** expands; changing a number and saving
      sticks; the sidebar **Bubble Factory** switch and the card's switch stay in sync; no sideways
      scroll on mobile.

## 6. Daily XP Pot (`/pot`, dashboard **Gambling → 💰 Daily XP Pot**)
- [ ] `/pot setup channel:#gambling` (or on the dashboard) → "Daily XP Pot is on", with the next
      draw time.
- [ ] 👤 Lose a few `/gamble` games → `/pot view` shows the pot growing, and you in **Top pot
      contributors**. Win a game → the pot doesn't change.
- [ ] Dashboard: change the title, color and text (try `{pot}` and `{draw}`), add a banner image →
      the preview updates as you type. Save, then run `/pot preview` → Discord shows the same.
- [ ] **Test the draw without waiting until midnight:** have 👤 and a friend each send **3+ messages
      at least 20 seconds apart**. Then run `/pot draw` (or dashboard **⏱️ Post & draw now**):
  - [ ] The pot posts in the channel with your ping role, "How to win", the pot amount, a live
        countdown ("in 10 minutes"), "Entered so far" and the top 3 contributors.
  - [ ] 👤 Lose another game during the countdown → within ~30s the posted pot shows the higher
        amount.
  - [ ] The post has a **🏆 Prizes right now** line (e.g. "🥇 500 · 🥈 350 …"). It only lists as
        many places as people are entered.
  - [ ] When the countdown ends, the post changes to "we have a winner!" and lists every winner
        with their prize, and a message pings all of them. Each winner's XP goes up by their prize
        (check `/levels rank`).
  - [ ] `/pot history` and the dashboard's **Recent pots** list the winners and prizes.
- [ ] **Entrants:** with a couple of accounts chatting, `/pot entrants` lists who's ✅ entered (with
      message counts), who's ⏳ almost in ("1/3"), and says whether *you're* in. On the dashboard, the
      pot card's **🎟️ Entered right now** shows the same people. After a draw, `/pot entrants
      last:true` lists who was entered (winners marked 🏆), and each Recent pot has a "👥 N entered"
      list you can open.
- [ ] **Balance (after deploying):** on the dashboard pot card, **Share of losses** is 25%, **Top
      prize** 500, **Winners** 5, **Pot cap** 2,000 and **Rollover** 50% (unless you'd changed them
      yourself). The "📏 For scale" line shows chat XP per minute and what levels 5/10/20 cost. If the
      pot was already over 2,000, it now shows 2,000.
- [ ] **Tiered prizes:**
  - [ ] Dashboard **Prize ladder**: type 2000 → "🥇 500 · 🥈 350 · 🥉 245 · #4 171 · #5 119", with
        "+307 XP carries over". Type 300 → "🥇 300". Each place is lower than the one above.
  - [ ] Give the pot a big amount (lose some big gambles, or lower the top prize to e.g. 100 so a
        small pot is enough), have 2–3 accounts chat, and `/pot draw` → 1st gets the most, 2nd less,
        3rd less again. Half of what's left shows as "🔁 Rolled over" and appears in tomorrow's pot.
- [ ] **Pot cap (2,000 XP):** on the dashboard, set **Pot cap** to something small, e.g. 500
      (or `/pot setup channel:#… pot_cap:500`). Have 2–3 accounts chat, then lose gambles until the
      pot passes 500 → within ~15s the pot posts with "🔥 Full! Drawn early", even in the middle of
      the day, and it's drawn 10 minutes later. `/pot view` shows the pot at "500 / 500" at most,
      and the XP over the cap shows up in the next pot. Set the cap back to 2,000 afterwards.
- [ ] **Rollover:** run `/pot draw` when nobody has chatted for an hour → the post says "rolled
      over", and tomorrow's pot starts with **half** of that XP ("incl. … rolled over").
- [ ] The real thing: leave it on overnight. It posts at 23:50 UTC and draws at 00:00 UTC. A pot
      under 100 XP isn't posted at all and rolls over quietly.

## 7. Birthdays / Counting / Starboard (dashboard **Engagement**)
- [ ] `/birthday setup channel:#general` (optionally a role and an XP gift).
      `/birthday set` with **today's** date and an hour that has already passed today (UTC) → the post
      appears within ~5 minutes, and the role/XP is given.
- [ ] `/counting setup channel:#counting` → count 1, 2, 3 with two accounts → ✅ reactions.
      Same account twice in a row → ❌ and the count resets. `/counting set number:2` fixes it.
- [ ] `/starboard setup channel:#starboard stars:2` → star a message with 2 accounts (not the
      author) → it's reposted in #starboard, and the count updates as stars change.

## 8. Dashboard: everything in one place
- [ ] **Sidebar → Modules** has an on/off switch for: Welcome, Honeypot, Leveling, Chat drops,
      Auto-Role, Gambling, Daily XP Pot, XP Shop, Auto-mod, Logs, Alerts, Tickets, Birthdays,
      Counting and Starboard.
- [ ] Clicking a name there opens the right page/sub-tab. For example, *Auto-mod* opens
      Moderation → Auto-mod, and *Daily XP Pot* scrolls to the pot card.
- [ ] Turn on something that isn't set up yet (e.g. Daily XP Pot with no channel) → an error
      "Pick a channel… first" and the switch flips back.
- [ ] Flip a switch in the sidebar → the switch on that feature's page matches, and saving the
      page updates the sidebar switch too.
- [ ] **Overview → Modules** has a card for each new feature (Auto-mod, Daily XP Pot, XP Shop, Chat
      drops, Birthdays, Counting, Starboard). Each has a switch, a one-line status and a link.
- [ ] **Search bar** (top): type "pot", "auto-mod", "birthday", "storage", "booster" or "shop" →
      the feature comes first, and Enter jumps straight to it.
- [ ] **Leaderboard** page: someone with a shop badge shows it next to their name, plus any
      collectibles.
- [ ] **Commands** page lists `/automod`, `/shop`, `/pot`, `/birthday`, `/counting` and
      `/starboard`.
- [ ] **Server settings → Dashboard access:** new pages (Engagement, XP Shop) can be given to
      moderators. A moderator only sees the switches for pages they have.
- [ ] **Server settings → Backups:** make a backup → it lists "N shop item(s)". Restoring doesn't
      duplicate items or reset how many were sold.
- [ ] Every save shows up in **Server settings → Change history**.

## 8b. Embed Builder → forum channels
- [ ] Embed Builder → **Send to channel**: your forum channels are listed under "Forums".
- [ ] Pick a forum → **Post title** and its **Tags** appear. Sending without a title (or without a
      tag in a forum that requires one) shows an error and posts nothing.
- [ ] Fill in a title, tick a tag, Send → "✅ Forum post created!" and a new post appears in the forum
      with that title, tag and your embed.
- [ ] Switch to **Edit a bot message** (the post's link is already filled in), change the text, send →
      the post's first message updates.

## 8b-2. Embed Builder → JSON editor
- [ ] Build a message, then open the **📝 JSON editor** panel → it shows the current message as JSON.
- [ ] Keep it open and edit the builder above (change the content or a title) → the JSON updates live.
- [ ] Change the JSON (e.g. the title) and press **Apply to builder** → the builder and preview update
      to match, and "✓ Applied to the builder" shows.
- [ ] Paste invalid JSON and Apply → an "Invalid JSON…" message shows and the builder is unchanged.
- [ ] Press **Format** on messy JSON → it pretty-prints. **Copy** copies the JSON to the clipboard.

## 8c. Bot Chat (💬 top bar → talk through the bot)
- [ ] Open **Bot Chat** and pick a channel → the last ~25 messages appear, newest at the bottom, and
      refresh on their own every few seconds. The bot's own messages are marked **BOT · you**.
- [ ] Type a message and press Enter (or Send) → it posts in the channel as the bot and shows in the
      feed. **Server settings → Change history** has a "Spoke through the bot" entry.
- [ ] Put `@everyone` in a message and send → it posts but **does not ping** anyone.
- [ ] Hover a message → **↩** reply button. Click it, type, send → the bot's message is a reply to
      that one in Discord.
- [ ] A moderator **without** the Bot Chat page doesn't see the 💬 icon and can't open the page; give
      them "Bot Chat" in **Server settings → Dashboard access** and they can.

## 9. Free-tier health (check every week or two)
- [ ] Logs → Settings → Storage: **Database** well under 75% of 512 MB, **Bot memory** under ~80% of
      512 MB.
- [ ] If the database ever passes 75%, the bot trims old data automatically, only keeps moderation
      logs, and posts one alert a day in your bot-alerts channel. Lower *Keep log history* or turn
      off noisy log types (voice, slash commands) to help.
- [ ] Render dashboard: the service hasn't been restarted for running out of memory ("Out of memory").

If anything doesn't behave like this, note what you did and what you saw, and check the bot-alerts
channel and the Render logs around that time.
