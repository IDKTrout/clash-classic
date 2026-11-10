# Clash Classic website

A public site for Clash Classic players: leaderboards, player profiles and event history. It reads live from the **Clash Classic Public Data** Google Sheet, which copies only public columns from the mod sheet. When the mod team updates the mod sheet, the site updates on its own.

## How the data flows

```
Clash Mod Team sheet (private)  ──IMPORTRANGE──▶  Clash Classic Public Data (anyone with link can view)  ──▶  website
```

- The public sheet copies: Events, Players (Discord ID, display name, socials, other names, events played), Bot_Players, Rosters, Colors Used, All Player Stats, the Leaderboards category list (A:E) and Bot_Stats.
- It never copies pronouns, role IDs, mod notes or any mod-only tab.
- Players with **Exclude** ticked in the mod sheet are left out everywhere.
- Subs show on profiles and rosters but aren't ranked on leaderboards.
- To add or change a leaderboard category, edit the Leaderboards tab (A:E) in the mod sheet as you do now. The site follows it.

## Put it on GitHub Pages (one-time, about 10 minutes)

1. Make a free account at github.com if you don't have one.
2. Click **New repository**. Name it `clash-classic` and set it to **Public**. Click **Create repository**.
3. On the new repository page, click **uploading an existing file**. Drag in everything in this folder (`index.html`, `app.js`, `config.js`, `site.css`, `theme.css`, `README.md` and the `assets` folder). Click **Commit changes**.
4. Go to **Settings → Pages**. Under "Branch", pick `main` and `/ (root)`, then **Save**.
5. After a minute or two the site is live at `https://<your-github-name>.github.io/clash-classic/`.

To use your own web address later (like clashclassic.gg), buy the domain, then add it under **Settings → Pages → Custom domain**.

## Changing things

| I want to… | Edit |
|---|---|
| Change colours or fonts | `theme.css` |
| Swap the logo, banner or tab icon | Files in `assets/` (see `assets/README.md`) |
| Change the site name or tagline | `config.js` |
| Add a Discord invite or sign-up link | `config.js` (`discordInvite`, `signupUrl`) |
| Show more or fewer players per leaderboard | `config.js` (`leaderboardSize`) |

On GitHub you can edit a file in the browser: open it, click the pencil icon, change it, and click **Commit changes**. The site updates within a minute or two.

## Preview it on your computer

From this folder, run `python -m http.server 8766` and open http://localhost:8765. Opening `index.html` by double-clicking won't load the stats.

## Later: Discord login and sign-ups

Every player is already keyed on their Discord ID, so a "Log in with Discord" button and one-click event sign-ups can be added later with Supabase, without changing how the stats work.
