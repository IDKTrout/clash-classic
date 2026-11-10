/* Clash Classic site logic. Reads the public Google Sheet and renders the pages.
   Pages: #/  #/leaderboards/<game>/<event>  #/players  #/player/<discordId>
          #/events  #/event/<code>                                              */
(function () {
  "use strict";
  const CFG = window.CLASH_CONFIG || {};
  const app = document.getElementById("app");
  const TABS = ["Events", "Players", "PlayerRecords", "Rosters", "Colors", "Stats", "LeaderboardConfig", "Records"];

  // ---------- helpers ----------
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = (v) => {
    if (v == null || v === "") return NaN;
    const s = String(v).replace(/,/g, "").trim();
    if (s.endsWith("%")) return parseFloat(s) / 100;
    return parseFloat(s);
  };
  const isTrue = (v) => String(v).trim().toUpperCase() === "TRUE";
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const splitList = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);

  // "Mar 20, 2027, Mar 21, 2027" -> "Mar 20-21, 2027"
  // "Oct 3, 2026, Oct 4, 2026, Oct 10, 2026, Oct 11, 2026" -> "Oct 3-4 & 10-11, 2026"
  // Anything that isn't a list of dates (like "No dates yet") is shown as written.
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function formatDates(text) {
    const raw = String(text || "").trim();
    const found = [...raw.matchAll(/([A-Za-z]{3})[a-z]*\.? (\d{1,2}), (\d{4})/g)];
    if (!found.length || found.map((m) => m[0]).join(", ") !== raw.replace(/\s+/g, " ")) return raw;
    const days = found.map((m) => new Date(Date.UTC(+m[3], MONTHS.indexOf(m[1][0].toUpperCase() + m[1].slice(1, 3).toLowerCase()), +m[2])));
    if (days.some((d) => isNaN(d))) return raw;
    days.sort((a, b) => a - b);
    // Group back-to-back days into runs.
    const runs = [];
    days.forEach((d) => {
      const last = runs[runs.length - 1];
      if (last && d - last.end === 86400000) last.end = d;
      else if (!last || d - last.end > 0) runs.push({ start: d, end: d });
    });
    const mon = (d) => MONTHS[d.getUTCMonth()];
    const byYear = new Map();
    runs.forEach((r, i) => {
      const y = r.end.getUTCFullYear();
      // A run across New Year needs both years: "Dec 31, 2026-Jan 1, 2027".
      const key = r.start.getUTCFullYear() === y ? y : `span${i}`;
      if (!byYear.has(key)) byYear.set(key, []);
      byYear.get(key).push(r);
    });
    return [...byYear.entries()].map(([year, list]) => {
      if (typeof year === "string") {
        const r = list[0];
        return `${mon(r.start)} ${r.start.getUTCDate()}, ${r.start.getUTCFullYear()}-${mon(r.end)} ${r.end.getUTCDate()}, ${r.end.getUTCFullYear()}`;
      }
      let prevMonth = null;
      const parts = list.map((r) => {
        const sm = mon(r.start), em = mon(r.end);
        let s = (sm === prevMonth ? "" : sm + " ") + r.start.getUTCDate();
        if (r.end > r.start) s += "-" + (em === sm ? "" : em + " ") + r.end.getUTCDate();
        prevMonth = em;
        return s;
      });
      const joined = parts.length === 2 ? parts.join(" & ") : parts.join(", ");
      return `${joined}, ${year}`;
    }).join("; ");
  }
  const normGame = (g) => {
    const s = String(g).toLowerCase();
    if (s.includes("valorant")) return "Valorant";
    if (s.includes("rivals")) return "Marvel Rivals";
    if (s.includes("league")) return "League Of Legends";
    if (s.includes("overwatch")) return "OverWatch";
    return String(g).trim();
  };
  const gameVar = (g) => {
    const n = normGame(g);
    return { "Valorant": "--game-valorant", "Marvel Rivals": "--game-rivals", "League Of Legends": "--game-league", "OverWatch": "--game-overwatch" }[n] || "--game-other";
  };
  const gameChip = (g) => `<span class="chip" style="--chip: var(${gameVar(g)})">${esc(normGame(g) === "OverWatch" ? "Overwatch" : normGame(g))}</span>`;
  const statusChip = (s) => {
    const k = String(s || "").toLowerCase();
    const cls = k.includes("finish") ? "status-finished" : k.includes("upcoming") ? "status-upcoming" : k.includes("cancel") ? "status-canceled" : "";
    return `<span class="chip ${cls}">${esc(s || "TBA")}</span>`;
  };

  function parseCSV(text) {
    const rows = []; let row = []; let f = ""; let q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
        else f += c;
      } else if (c === '"') q = true;
      else if (c === ",") { row.push(f); f = ""; }
      else if (c === "\n") { row.push(f); rows.push(row); row = []; f = ""; }
      else if (c !== "\r") f += c;
    }
    if (f !== "" || row.length) { row.push(f); rows.push(row); }
    return rows;
  }

  async function fetchTab(tab) {
    const url = `https://docs.google.com/spreadsheets/d/${CFG.sheetId}/gviz/tq?tqx=out:csv&headers=1&sheet=${encodeURIComponent(tab)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Couldn't read the "${tab}" tab (HTTP ${res.status}).`);
    const text = await res.text();
    if (text.trim().startsWith("<")) throw new Error(`The "${tab}" tab isn't public. Share the public data sheet as "Anyone with the link can view".`);
    return parseCSV(text);
  }
  const toObjects = (rows) => {
    const [head, ...body] = rows;
    return body.filter((r) => r.some((c) => c !== "")).map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
  };

  // ---------- data model ----------
  let M = null;
  let currentLbGame = "";

  // ---------- Discord login (Supabase) ----------
  const sb = window.supabase && CFG.supabaseUrl && CFG.supabaseKey
    ? window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, { auth: { flowType: "pkce", detectSessionInUrl: true, persistSession: true } })
    : null;
  let me = null; // { id, name, username } of the logged-in Discord user

  function readUser(user) {
    if (!user) return null;
    const ident = (user.identities || []).find((i) => i.provider === "discord");
    const idata = (ident && ident.identity_data) || {};
    const md = user.user_metadata || {};
    const id = idata.provider_id || idata.sub || md.provider_id || md.sub || "";
    const username = String(md.name || idata.name || "").replace(/#0$/, "");
    const name = (md.custom_claims && md.custom_claims.global_name) || md.full_name || username || "Player";
    return id ? { id: String(id), name, username } : null;
  }

  async function login() {
    if (!sb) return;
    try { sessionStorage.setItem("clash-return", location.hash || "#/"); } catch (e) { /* storage blocked */ }
    const { error } = await sb.auth.signInWithOAuth({ provider: "discord", options: { redirectTo: location.origin + location.pathname } });
    if (error) alertBox(`Couldn't start Discord login: ${error.message}`);
  }
  async function logout() {
    if (sb) await sb.auth.signOut();
    me = null; renderAuth(); route();
  }
  function alertBox(msg) {
    const div = document.createElement("div");
    div.className = "error"; div.textContent = msg;
    app.prepend(div);
  }

  function renderAuth() {
    const slot = document.getElementById("nav-auth");
    if (!slot) return;
    if (!sb) { slot.innerHTML = ""; return; }
    slot.innerHTML = me
      ? `<a href="#/me" data-nav="me">My profile</a><button class="nav-logout" type="button" data-action="logout">Log out</button>`
      : `<button class="nav-login" type="button" data-action="login">Log in with Discord</button>`;
  }

  document.addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-action]");
    if (!btn) return;
    if (btn.dataset.action === "login") { ev.preventDefault(); login(); }
    if (btn.dataset.action === "logout") { ev.preventDefault(); logout(); }
  });

  // ---------- event sign-ups ----------
  const isPastEvent = (e) => e.canceled || !!e.winner || /finish|cancel/i.test(e.status);
  function nextEvent() {
    const future = M.events.filter((e) => !isPastEvent(e));
    return future.find((e) => /upcoming/i.test(e.status)) || future[0] || null;
  }
  // The event's Tally link with hidden fields filled in, so each response carries the event and Discord ID.
  function signupLink(e, withUser) {
    try {
      const u = new URL(e.signupUrl);
      u.searchParams.set("event", e.code);
      if (withUser && me) { u.searchParams.set("discord_id", me.id); u.searchParams.set("discord_username", me.username); }
      return u.toString();
    } catch (err) { return e.signupUrl; }
  }
  function signupBlock(e) {
    if (!e || !e.signupUrl) return "";
    let main;
    if (me) main = `<a class="btn btn-primary" href="${esc(signupLink(e, true))}" target="_blank" rel="noopener" data-signup-btn="${esc(e.code)}">Sign up for ${esc(e.name)}</a>`;
    else if (sb) main = `<button class="btn btn-primary btn-discord" type="button" data-action="login">Log in with Discord to sign up</button>`;
    else main = `<a class="btn btn-primary" href="${esc(signupLink(e, false))}" target="_blank" rel="noopener">Sign up for ${esc(e.name)}</a>`;
    const alt = !me && sb ? `<a class="signup-alt" href="${esc(signupLink(e, false))}" target="_blank" rel="noopener">or sign up without logging in</a>` : "";
    return `<div class="signup">${main}${alt}<span class="signup-count" data-count="${esc(e.code)}"></span></div>`;
  }
  // Fill in sign-up counts and "already signed up" states after a page renders.
  async function fillSignupInfo() {
    if (!sb) return;
    for (const el of app.querySelectorAll("[data-count]")) {
      const { data, error } = await sb.rpc("signup_count", { p_event: el.dataset.count });
      if (error || typeof data !== "number") continue;
      el.textContent = data === 0 ? "Be the first to sign up" : `${data} ${data === 1 ? "player" : "players"} signed up`;
    }
    if (!me) return;
    for (const btn of app.querySelectorAll("[data-signup-btn]")) {
      const { data } = await sb.rpc("is_signed_up", { p_event: btn.dataset.signupBtn });
      if (data === true) { btn.textContent = "You're signed up (edit your answers)"; btn.classList.remove("btn-primary"); }
    }
  }
  async function load() {
    const raw = Object.fromEntries(await Promise.all(TABS.map(async (t) => [t, await fetchTab(t)])));
    const m = {};

    m.events = toObjects(raw.Events).map((e, i) => ({
      order: i, code: e.Code, name: e.Event, games: splitList(e.Game).map(normGame), dates: formatDates(e.Dates),
      status: e.Status, winner: e["Winning Team"], notes: e.Notes, canceled: isTrue(e.Canceled),
      runnerUp: e["Runner Up"] || "", third: e["Third Place"] || "", signupUrl: e["Sign Up Link"] || "",
    }));
    // 1 = champions, 2 = runner up, 3 = third place, 0 = no placement.
    m.placement = (eventName, team) => {
      const e = m.eventByName.get(eventName);
      if (!e || !team) return 0;
      return team === e.winner ? 1 : team === e.runnerUp ? 2 : team === e.third ? 3 : 0;
    };
    m.eventByName = new Map(m.events.map((e) => [e.name, e]));
    m.eventOrder = (name) => (m.eventByName.get(name) || { order: 999 }).order;

    m.players = new Map();
    toObjects(raw.Players).forEach((p) => m.players.set(p["Discord ID"], {
      id: p["Discord ID"], name: p["Display Name"] || p["Discord ID"], socials: p.Socials,
      aliases: p["Other Names Used"], appearances: num(p["Events Played"]) || 0, wins: 0, eventsWon: [], eventsPlayed: [],
    }));
    toObjects(raw.PlayerRecords).forEach((r) => {
      const p = m.players.get(r["Discord ID"]); if (!p) return;
      p.appearances = num(r.Appearances) || p.appearances;
      p.wins = num(r.Wins) || 0;
      p.eventsPlayed = splitList(r["Events Played"]);
      p.eventsWon = splitList(r["Events Won"]);
    });

    m.rosters = toObjects(raw.Rosters).map((r) => ({
      // A roster cell can list several games, e.g. "Valorant, Marvel Rivals, OverWatch".
      event: r.Event, game: normGame(r.Game), games: splitList(r.Game).map(normGame), team: r.Team, name: r.Name, id: r["Discord ID"], sub: isTrue(r.Sub),
    }));
    m.subs = new Set(m.rosters.filter((r) => r.sub).map((r) => `${r.event}|${r.id}`));

    m.colors = new Map();
    toObjects(raw.Colors).forEach((c) => m.colors.set(`${c.Event}|${c.Team}`, c.Hex));
    m.teamColor = (event, team) => m.colors.get(`${event}|${team}`) || "";

    // Stats keep their original column positions so LeaderboardConfig's column numbers line up.
    const [statHead, ...statBody] = raw.Stats;
    m.statHead = statHead || [];
    m.stats = statBody.filter((r) => r[0]).map((r) => ({
      event: r[0], game: normGame(r[1]), team: r[2], ign: r[3], id: r[4], maps: num(r[5]) || 0, cells: r,
      sub: false,
    }));
    m.stats.forEach((s) => { s.sub = m.subs.has(`${s.event}|${s.id}`); });

    m.lbConfig = toObjects(raw.LeaderboardConfig).filter((c) => c.Game && c.Category).map((c) => ({
      game: normGame(c.Game), category: c.Category, col: parseInt(c["Stats Column"], 10), lowest: /low/i.test(c.Order), perRound: isTrue(c["Per Round"]),
    }));

    m.records = toObjects(raw.Records).map((r) => ({
      event: r.Event, game: normGame(r.Game), type: r.Type, category: r.Category, rank: num(r.Rank), id: r["Discord ID"], player: r.Player, value: r.Value,
    }));

    m.name = (id, fallback) => (m.players.get(id) || {}).name || fallback || id;
    m.games = [...new Set(m.lbConfig.map((c) => c.game))];
    return m;
  }

  // Team colour dot; teams with no colour in the sheet get a neutral dot so rows still line up.
  function teamDot(event, team) {
    const c = M.teamColor(event, team);
    return `<span class="team-dot"${c ? ` style="--team:${esc(c)}"` : ""}></span>`;
  }

  const PLACE_LABEL = { 1: "Champions", 2: "Runner-up", 3: "3rd place" };
  function placeChip(n, singular) {
    if (!n) return "";
    const label = n === 1 && singular ? "Champion" : PLACE_LABEL[n];
    return `<span class="chip place-${n}">${label}</span>`;
  }

  // ---------- leaderboard maths ----------
  const RATIO = /k\/d|acs|kda|avg|adr|%|kast|accuracy|dd/i;
  function isPercentCat(cat, head) { return /%|kast|accuracy/i.test(cat) || /%|kast|accuracy/i.test(head || ""); }
  function fmt(v, cat, head) {
    if (!isFinite(v)) return "–";
    if (isPercentCat(cat, head) && Math.abs(v) <= 1.5) return `${(v * 100).toFixed(0)}%`;
    if (Number.isInteger(v)) return v.toLocaleString();
    return Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : v.toFixed(2);
  }

  /** Rank players for one category. event = event name or "all". */
  function leaderboard(cfg, event, limit) {
    const rows = M.stats.filter((s) => s.game === cfg.game && !s.sub && (event === "all" || s.event === event));
    const head = M.statHead[cfg.col - 1] || cfg.category;
    const ratio = !cfg.perRound && RATIO.test(cfg.category);
    const agg = new Map();
    rows.forEach((s) => {
      const v = num(s.cells[cfg.col - 1]);
      if (!isFinite(v)) return;
      const a = agg.get(s.id) || { id: s.id, ign: s.ign, sum: 0, wsum: 0, maps: 0, events: 0 };
      a.sum += v; a.wsum += v * (s.maps || 1); a.maps += s.maps || 1; a.events += 1;
      agg.set(s.id, a);
    });
    // All-time "lowest" stats (deaths) are compared per map so part-timers don't win by default.
    const perMapLowest = cfg.lowest && event === "all";
    const list = [...agg.values()].map((a) => {
      let value;
      if (cfg.perRound || perMapLowest) value = a.sum / a.maps;
      else if (ratio) value = a.wsum / a.maps;
      else value = a.sum;
      return { ...a, value };
    }).filter((a) => isFinite(a.value));
    list.sort((x, y) => (cfg.lowest ? x.value - y.value : y.value - x.value));
    const note = cfg.perRound || perMapLowest ? "per map" : ratio && event === "all" ? "career avg" : event === "all" ? "career total" : "";
    return { rows: list.slice(0, limit), note, head };
  }

  function eventsWithStats(game) {
    return [...new Set(M.stats.filter((s) => s.game === game).map((s) => s.event))].sort((a, b) => M.eventOrder(a) - M.eventOrder(b));
  }

  function lbCard(cfg, event, limit) {
    const { rows, note, head } = leaderboard(cfg, event, limit);
    const items = rows.length
      ? rows.map((r, i) => `<li><span class="rank">${i + 1}</span><span class="who"><a href="#/player/${encodeURIComponent(r.id)}">${esc(M.name(r.id, r.ign))}</a>${event === "all" ? `<span class="meta">${r.events} ev</span>` : ""}</span><span class="val">${fmt(r.value, cfg.category, head)}</span></li>`).join("")
      : `<li class="empty">No stats yet.</li>`;
    return `<div class="card lb"><h3>${esc(cfg.category)}${note ? `<small>${note}</small>` : ""}</h3><ol>${items}</ol></div>`;
  }

  // ---------- per-game stat lists (the same stats the Discord bot's /stats shows) ----------
  // kind: "sum" adds up across events, "avg" is a per-map average (weighted by maps),
  // "kd" is kills / deaths and "kda" is (kills + assists) / deaths, both recalculated from the totals.
  const GAME_STATS = {
    "Valorant": {
      start: (h) => h.indexOf("ACS"),
      fields: [["ACS", "avg"], ["K", "sum"], ["D", "sum"], ["A", "sum"], ["+/-", "sum"], ["K/D", "kd"], ["DDΔ", "avg"],
        ["ADR", "avg"], ["HS%", "avg"], ["KAST", "avg"], ["FK", "avg"], ["FD", "avg"], ["MK", "sum"]],
      kda: ["K", "D", "A"],
    },
    "Marvel Rivals": {
      start: (h) => h.indexOf("Kills"),
      fields: [["Kills", "sum"], ["Deaths", "sum"], ["Assists", "sum"], ["Most Damage", "sum"], ["Most Kills", "sum"],
        ["Most Damaged Blocked", "sum"], ["Most Healing", "sum"], ["Most Assists", "sum"], ["3k", "sum"], ["4k", "sum"],
        ["5k", "sum"], ["6k", "sum"], ["Final Hits", "sum"], ["Damage", "sum"], ["Damage Blocked", "sum"],
        ["Healing", "sum"], ["AVG Accuracy", "avg"], ["MVP/SVP", "sum"]],
      kda: ["Kills", "Deaths", "Assists"],
    },
    "League Of Legends": {
      start: (h) => h.lastIndexOf("Kills"),
      fields: [["Kills", "sum"], ["Deaths", "sum"], ["Assists", "sum"], ["KDA", "kda"], ["Avg Damage", "avg"], ["Avg Gold", "avg"]],
      kda: ["Kills", "Deaths", "Assists"],
    },
  };

  // Column positions for one game's stats. Games reuse names like "Kills", so each
  // game's fields are looked up only inside its own block of columns.
  const fieldCache = {};
  function gameFields(game) {
    if (fieldCache[game]) return fieldCache[game];
    const head = M.statHead;
    const spec = GAME_STATS[game];
    if (!spec) return (fieldCache[game] = []);
    const starts = Object.values(GAME_STATS).map((g) => g.start(head)).filter((i) => i >= 0).sort((a, b) => a - b);
    const start = spec.start(head);
    const end = starts.find((i) => i > start) ?? head.length;
    fieldCache[game] = spec.fields.map(([name, kind]) => {
      const col = head.indexOf(name, start);
      return { name, kind, col: col >= 0 && col < end ? col : -1 };
    }).filter((f) => f.col >= 0);
    return fieldCache[game];
  }

  const total = (rows, f) => {
    const vals = rows.map((s) => num(s.cells[f.col])).filter(isFinite);
    return vals.length ? vals.reduce((t, v) => t + v, 0) : NaN;
  };
  function careerValue(f, rows, fields) {
    const byName = (n) => fields.find((x) => x.name === n);
    if (f.kind === "sum") return total(rows, f);
    if (f.kind === "kd" || f.kind === "kda") {
      const [k, d, a] = (GAME_STATS[rows[0].game] || {}).kda || [];
      const kills = byName(k) ? total(rows, byName(k)) : NaN;
      const deaths = byName(d) ? total(rows, byName(d)) : NaN;
      const assists = byName(a) ? total(rows, byName(a)) : NaN;
      if (!(deaths > 0)) return NaN;
      return f.kind === "kd" ? kills / deaths : (kills + assists) / deaths;
    }
    const vals = rows.map((s) => [num(s.cells[f.col]), s.maps || 1]).filter(([v]) => isFinite(v));
    const weight = vals.reduce((t, [, w]) => t + w, 0);
    return weight ? vals.reduce((t, [v, w]) => t + v * w, 0) / weight : NaN;
  }

  // The bot's "Career Summary": maps, kills/deaths/assists, K/D or KDA and per-map rates.
  function careerSummary(game, rows, fields) {
    const spec = GAME_STATS[game];
    if (!spec) return [];
    const f = (n) => fields.find((x) => x.name === n);
    const [k, d, a] = spec.kda;
    const kills = f(k) ? total(rows, f(k)) : NaN;
    const deaths = f(d) ? total(rows, f(d)) : NaN;
    const assists = f(a) ? total(rows, f(a)) : NaN;
    const maps = rows.reduce((t, s) => t + (s.maps || 0), 0);
    const out = [["Maps", maps || "–"], ["Kills", fmt(kills)], ["Deaths", fmt(deaths)], ["Assists", fmt(assists)]];
    if (game === "League Of Legends") out.push(["KDA", fmt(deaths > 0 ? (kills + assists) / deaths : NaN)]);
    else out.push(["K/D", fmt(deaths > 0 ? kills / deaths : NaN)]);
    if (game === "Marvel Rivals") {
      ["Final Hits", "Damage", "Damage Blocked", "Healing", "MVP/SVP"].forEach((n) => f(n) && out.push([n, fmt(total(rows, f(n)))]));
    } else if (maps) {
      out.push(["Kills / map", fmt(kills / maps)], ["Deaths / map", fmt(deaths / maps)], ["Assists / map", fmt(assists / maps)]);
    }
    return out;
  }

  // ---------- pages ----------
  function pageHome() {
    const finished = M.events.filter((e) => /finish/i.test(e.status));
    const latest = finished[finished.length - 1];
    const upcoming = nextEvent();
    const signup = signupBlock(upcoming);
    const latestColor = latest ? M.teamColor(latest.name, latest.winner) : "";

    const featured = M.games.map((g) => {
      const evs = eventsWithStats(g);
      if (!evs.length) return "";
      const cfg = M.lbConfig.find((c) => c.game === g);
      return lbCard({ ...cfg, category: `${g === "League Of Legends" ? "League" : g}: ${cfg.category}` , game: g, col: cfg.col }, "all", 5);
    }).join("");

    return `
      <section class="hero">
        <span class="eyebrow">Community tournaments</span>
        <h1>${esc(CFG.siteName || "Clash Classic")}</h1>
        <p>${esc(CFG.tagline || "")}</p>
        ${signup}
        <div class="hero-actions">
          <a class="btn ${signup ? "" : "btn-primary"}" href="#/leaderboards">View leaderboards</a>
          <a class="btn" href="#/events">Past events</a>
        </div>
      </section>

      <section class="stat-row">
        <div class="card stat"><div class="value num">${M.players.size}</div><div class="label">Players</div></div>
        <div class="card stat"><div class="value num">${finished.length}</div><div class="label">Events played</div></div>
        <div class="card stat"><div class="value small">${latest ? `${teamDot(latest.name, latest.winner)} ${esc(latest.winner)}` : "–"}</div><div class="label">${latest ? `${esc(latest.name)} champions` : "Latest champions"}</div></div>
        <div class="card stat"><div class="value small">${upcoming ? esc(upcoming.name) : "TBA"}</div><div class="label">${upcoming ? `Next up · ${esc(upcoming.dates)}` : "Next event"}</div></div>
      </section>

      <section class="section">
        <div class="section-head"><h2>All-time leaders</h2><a href="#/leaderboards">All leaderboards →</a></div>
        <div class="lb-grid">${featured}</div>
      </section>`;
  }

  function pageLeaderboards(gameSlug, eventSlug) {
    const games = M.games.filter((g) => eventsWithStats(g).length);
    const game = games.find((g) => slug(g) === gameSlug) || games[0];
    if (!game) return `<p class="muted">No stats yet.</p>`;
    currentLbGame = slug(game);
    const evs = eventsWithStats(game);
    const event = evs.find((e) => slug(e) === eventSlug) || "all";
    const cfgs = M.lbConfig.filter((c) => c.game === game);
    const limit = CFG.leaderboardSize || 10;

    const tabs = games.map((g) => `<a class="tab ${g === game ? "active" : ""}" style="--tab: var(${gameVar(g)})" href="#/leaderboards/${slug(g)}/all">${esc(g)}</a>`).join("");
    const opts = [`<option value="all">All events (career)</option>`, ...evs.map((e) => `<option value="${esc(slug(e))}" ${e === event ? "selected" : ""}>${esc(e)}</option>`)].join("");

    const recs = M.records.filter((r) => r.game === game && !/event total/i.test(r.type) && (event === "all" || r.event === event));
    const recGroups = new Map();
    recs.forEach((r) => { const k = r.category; if (!recGroups.has(k)) recGroups.set(k, []); recGroups.get(k).push(r); });
    const recCards = [...recGroups.entries()].map(([cat, list]) => {
      const top = list.slice().sort((a, b) => num(b.value) - num(a.value)).slice(0, 5);
      return `<div class="card lb"><h3>${esc(cat)}<small>one round</small></h3><ol>${top.map((r, i) => `<li><span class="rank">${i + 1}</span><span class="who"><a href="#/player/${encodeURIComponent(r.id)}">${esc(M.name(r.id, r.player))}</a>${event === "all" ? `<span class="meta">${esc(r.event)}</span>` : ""}</span><span class="val">${fmt(num(r.value), cat)}</span></li>`).join("")}</ol></div>`;
    }).join("");

    return `
      <section class="section">
        <h1>Leaderboards</h1>
        <div class="tabs" role="tablist">${tabs}</div>
        <div class="controls">
          <label for="lb-event">Event <select id="lb-event">${opts}</select></label>
          <span class="muted">Subs aren't ranked.</span>
        </div>
      </section>
      <section class="lb-grid">${cfgs.map((c) => lbCard(c, event, limit)).join("")}</section>
      ${recCards ? `<section class="section"><h2>Single-round records</h2><div class="lb-grid">${recCards}</div></section>` : ""}`;
  }

  function pagePlayers() {
    return `
      <section class="section">
        <h1>Players</h1>
        <div class="controls">
          <label for="player-search">Search <input id="player-search" type="search" placeholder="Name or alias" autocomplete="off"></label>
          <label for="player-sort">Sort <select id="player-sort"><option value="apps">Most events</option><option value="wins">Most wins</option><option value="name">Name</option></select></label>
        </div>
      </section>
      <section class="grid" id="player-grid"></section>`;
  }
  function renderPlayerGrid() {
    const q = (document.getElementById("player-search").value || "").toLowerCase();
    const sort = document.getElementById("player-sort").value;
    let list = [...M.players.values()].filter((p) => !q || p.name.toLowerCase().includes(q) || (p.aliases || "").toLowerCase().includes(q));
    list.sort((a, b) => sort === "name" ? a.name.localeCompare(b.name) : sort === "wins" ? b.wins - a.wins || b.appearances - a.appearances : b.appearances - a.appearances || b.wins - a.wins);
    document.getElementById("player-grid").innerHTML = list.map((p) => `
      <a class="card player-card" href="#/player/${encodeURIComponent(p.id)}">
        <span class="name">${esc(p.name)}</span>
        ${p.aliases ? `<span class="aka">aka ${esc(p.aliases)}</span>` : ""}
        <span class="line"><span><b class="num">${p.appearances}</b> events</span><span><b class="num">${p.wins}</b> ${p.wins ? '<span class="trophy">wins</span>' : "wins"}</span></span>
      </a>`).join("") || `<p class="muted">No players match "${esc(q)}".</p>`;
  }

  function pagePlayer(id) {
    const p = M.players.get(id);
    if (!p) return `<p class="muted">That player isn't on the list. <a href="#/players">Back to players</a></p>`;
    // One line per event: a player who played several games at the same event
    // (e.g. Clash 5 Valorant and Marvel Rivals) gets one line with every game listed.
    const byEvent = new Map();
    M.rosters.filter((r) => r.id === id).forEach((r) => {
      const e = byEvent.get(r.event) || { event: r.event, teams: [], games: [], sub: false };
      if (!e.teams.includes(r.team)) e.teams.push(r.team);
      (r.games.length ? r.games : [r.game]).forEach((g) => { if (!e.games.includes(g)) e.games.push(g); });
      e.sub = e.sub || r.sub;
      byEvent.set(r.event, e);
    });
    const history = [...byEvent.values()].sort((a, b) => M.eventOrder(a.event) - M.eventOrder(b.event));
    const histRows = history.map((r) => {
      const ev = M.eventByName.get(r.event);
      const places = r.teams.map((t) => M.placement(r.event, t)).filter(Boolean);
      const place = places.length ? Math.min(...places) : 0;
      const teams = r.teams.map((t) => `${teamDot(r.event, t)}<span>${esc(t)}</span>`).join("");
      return `<div class="card history-row">
        <a href="#/event/${encodeURIComponent(ev ? ev.code : r.event)}">${esc(r.event)}</a>
        <span class="team">${teams}${r.sub ? '<span class="sub-tag">Sub</span>' : ""}</span>
        <span class="game-slot">${r.games.map(gameChip).join("")}</span>
        <span class="champ-slot">${placeChip(place, true)}</span>
      </div>`;
    }).join("");

    const games = [...new Set(M.stats.filter((s) => s.id === id).map((s) => s.game))];
    const statTables = games.map((g) => {
      const rows = M.stats.filter((s) => s.id === id && s.game === g).sort((a, b) => M.eventOrder(a.event) - M.eventOrder(b.event));
      const fields = gameFields(g);
      const titles = new Set(rows.filter((s) => M.placement(s.event, s.team) === 1).map((s) => s.event)).size;
      const summary = careerSummary(g, rows, fields)
        .map(([label, value]) => `<div class="sum-item"><span class="sum-label">${esc(label)}</span><span class="sum-value num">${value}</span></div>`).join("");
      const body = rows.map((s) => `<tr><td>${esc(s.event)}${s.sub ? ' <span class="sub-tag">Sub</span>' : ""}</td><td>${s.maps || "–"}</td>${fields.map((f) => `<td>${fmt(num(s.cells[f.col]), f.name)}</td>`).join("")}</tr>`).join("");
      const career = fields.map((f) => `<td>${fmt(careerValue(f, rows, fields), f.name)}</td>`).join("");
      const totMaps = rows.reduce((t, s) => t + (s.maps || 0), 0);
      return `<div class="section">
        <h3>${gameChip(g)}</h3>
        <div class="career-summary">
          <div class="sum-item"><span class="sum-label">Events</span><span class="sum-value num">${rows.length}</span></div>
          <div class="sum-item"><span class="sum-label">Championships</span><span class="sum-value num">${titles}</span></div>
          ${summary}
        </div>
        <div class="table-scroll"><table>
        <thead><tr><th>Event</th><th>Maps</th>${fields.map((f) => `<th>${esc(f.name)}</th>`).join("")}</tr></thead>
        <tbody>${body}${rows.length > 1 ? `<tr class="career"><td>Career</td><td>${totMaps || "–"}</td>${career}</tr>` : ""}</tbody></table></div></div>`;
    }).join("");

    return `
      <section class="profile-head">
        <a class="muted" href="#/players">← All players</a>
        <h1>${esc(p.name)}</h1>
        ${p.aliases ? `<div class="aka">Also played as ${esc(p.aliases)}</div>` : ""}
        ${p.socials ? `<div class="muted">Socials: ${esc(p.socials)}</div>` : ""}
      </section>
      <section class="stat-row">
        <div class="card stat"><div class="value num">${p.appearances}</div><div class="label">Events played</div></div>
        <div class="card stat"><div class="value num">${p.wins}</div><div class="label">Championships</div></div>
        <div class="card stat"><div class="value small">${p.eventsWon.length ? p.eventsWon.map(esc).join(", ") : "–"}</div><div class="label">Titles</div></div>
      </section>
      ${statTables ? `<section class="section"><h2>Stats</h2>${statTables}</section>` : ""}
      <section class="section"><h2>Event history</h2><div class="history">${histRows || '<p class="muted">No roster history yet.</p>'}</div></section>`;
  }

  // Past events (finished, canceled, or already have a winner) plus only the next upcoming one.
  function visibleEvents() {
    const next = nextEvent();
    return M.events.filter((e) => isPastEvent(e) || e === next);
  }

  function pageEvents() {
    const list = visibleEvents().reverse();
    return `
      <section class="section"><h1>Events</h1><p class="muted">Every Clash, newest first.</p></section>
      <section class="grid">${list.map((e) => {
        const color = M.teamColor(e.name, e.winner);
        return `<a class="card event-card" href="#/event/${encodeURIComponent(e.code)}">
          <div class="top"><span class="code">${esc(e.code)}</span>${statusChip(e.canceled ? "Canceled" : e.status)}</div>
          <h3>${esc(e.name)}</h3>
          <div class="chips">${e.games.map(gameChip).join("")}</div>
          <div class="muted">${esc(e.dates)}</div>
          ${!isPastEvent(e) && e.signupUrl ? `<div class="card-signup"><span class="chip status-upcoming">Sign-ups open</span><span class="signup-count" data-count="${esc(e.code)}"></span></div>` : ""}
          ${e.winner ? `<ol class="podium">${[e.winner, e.runnerUp, e.third].map((t, i) => t ? `<li class="podium-${i + 1}"><span class="podium-rank">${["1st", "2nd", "3rd"][i]}</span>${teamDot(e.name, t)}<span>${esc(t)}</span></li>` : "").join("")}</ol>` : ""}
        </a>`;
      }).join("")}</section>`;
  }

  function pageEvent(code) {
    const e = M.events.find((x) => x.code === code || x.name === code);
    if (!e) return `<p class="muted">Event not found. <a href="#/events">Back to events</a></p>`;
    const teams = new Map();
    M.rosters.filter((r) => r.event === e.name).forEach((r) => { if (!teams.has(r.team)) teams.set(r.team, []); teams.get(r.team).push(r); });
    const rank = (t) => M.placement(e.name, t) || 9;
    const teamOrder = [...teams.keys()].sort((a, b) => rank(a) - rank(b));
    const teamCards = teamOrder.map((t) => `
      <div class="card team-card" style="--team:${esc(M.teamColor(e.name, t))}">
        <h3><span>${esc(t)}</span>${placeChip(M.placement(e.name, t))}</h3>
        <ul>${teams.get(t).map((r) => `<li><a href="#/player/${encodeURIComponent(r.id)}">${esc(M.name(r.id, r.name))}</a>${r.sub ? '<span class="sub-tag">Sub</span>' : ""}</li>`).join("")}</ul>
      </div>`).join("");

    const statGames = [...new Set(M.stats.filter((s) => s.event === e.name).map((s) => s.game))];
    const leaders = statGames.map((g) => `
      <div class="section-head"><h3>${gameChip(g)}</h3><a href="#/leaderboards/${slug(g)}/${slug(e.name)}">Full leaderboard →</a></div>
      <div class="lb-grid">${M.lbConfig.filter((c) => c.game === g).slice(0, 3).map((c) => lbCard(c, e.name, 3)).join("")}</div>`).join("");

    return `
      <section class="profile-head">
        <a class="muted" href="#/events">← All events</a>
        <div class="chips">${statusChip(e.canceled ? "Canceled" : e.status)}${e.games.map(gameChip).join("")}</div>
        <h1>${esc(e.name)}</h1>
        <div class="muted">${esc(e.dates)}</div>
        ${e.notes ? `<p class="muted">${esc(e.notes)}</p>` : ""}
        ${e === nextEvent() ? signupBlock(e) : ""}
      </section>
      ${leaders ? `<section class="section"><h2>Top performers</h2>${leaders}</section>` : ""}
      <section class="section"><h2>Teams</h2>${teamCards ? `<div class="grid">${teamCards}</div>` : '<p class="muted">Rosters haven\'t been posted yet.</p>'}</section>`;
  }

  function pageMe() {
    if (!sb) return `<p class="muted">Discord login isn't set up on this site yet.</p>`;
    if (!me) return `
      <section class="profile-head">
        <h1>My profile</h1>
        <p class="muted">Log in with Discord to see your Clash stats and sign up for events.</p>
        <div><button class="btn btn-primary btn-discord" type="button" data-action="login">Log in with Discord</button></div>
      </section>`;
    if (M.players.has(me.id)) return pagePlayer(me.id);
    const next = nextEvent();
    return `
      <section class="profile-head">
        <h1>Welcome, ${esc(me.name)}</h1>
        <p class="muted">You don't have any Clash stats yet. Once you've played in an event, your profile shows up here.</p>
        ${next && next.signupUrl ? signupBlock(next) : `<p class="muted">Sign-ups for the next Clash aren't open yet.</p>`}
      </section>`;
  }

  // ---------- router ----------
  function route() {
    if (!M) return;
    const parts = (location.hash.replace(/^#\/?/, "") || "").split("/").map(decodeURIComponent);
    const page = parts[0] || "home";
    let html;
    switch (page) {
      case "leaderboards": html = pageLeaderboards(parts[1], parts[2]); break;
      case "players": html = pagePlayers(); break;
      case "player": html = pagePlayer(parts[1]); break;
      case "events": html = pageEvents(); break;
      case "event": html = pageEvent(parts[1]); break;
      case "me": html = pageMe(); break;
      default: html = pageHome();
    }
    app.innerHTML = html;
    const ownProfile = me && page === "player" && parts[1] === me.id;
    const navKey = ownProfile ? "me" : ({ player: "players", event: "events" }[page] || page);
    document.querySelectorAll("[data-nav]").forEach((a) => a.classList.toggle("active", a.dataset.nav === navKey));
    window.scrollTo(0, 0);
    fillSignupInfo();

    if (page === "players") {
      renderPlayerGrid();
      document.getElementById("player-search").addEventListener("input", renderPlayerGrid);
      document.getElementById("player-sort").addEventListener("change", renderPlayerGrid);
    }
    if (page === "leaderboards") {
      document.getElementById("lb-event").addEventListener("change", (ev) => {
        location.hash = `#/leaderboards/${currentLbGame}/${ev.target.value}`;
      });
    }
  }

  // ---------- start ----------
  document.querySelectorAll("[data-site-name]").forEach((el) => { el.textContent = CFG.siteName || "Clash Classic"; });
  document.title = CFG.siteName || "Clash Classic";
  if (CFG.discordInvite) { const a = document.getElementById("footer-discord"); a.href = CFG.discordInvite; a.hidden = false; }
  window.addEventListener("hashchange", route);
  renderAuth();

  // After Discord sends the player back, tidy the address bar and return them to the page they were on.
  function afterLogin() {
    if (/[?&](code|error)=/.test(location.search)) history.replaceState(null, "", location.pathname + location.hash);
    let back = null;
    try { back = sessionStorage.getItem("clash-return"); sessionStorage.removeItem("clash-return"); } catch (e) { /* storage blocked */ }
    if (back && back !== location.hash) location.hash = back;
  }
  if (sb) {
    sb.auth.onAuthStateChange((event, session) => {
      const next = readUser(session && session.user);
      const changed = (next && next.id) !== (me && me.id);
      me = next;
      if (event === "SIGNED_IN" && changed) afterLogin();
      if (changed) { renderAuth(); route(); }
    });
  }

  load().then((m) => {
    M = m;
    const next = nextEvent();
    if (next && next.signupUrl) { const a = document.getElementById("nav-signup"); a.href = `#/event/${encodeURIComponent(next.code)}`; a.hidden = false; }
    route();
  }).catch((err) => {
    console.error(err);
    app.innerHTML = `<div class="error"><strong>Couldn't load the stats.</strong><p>${esc(err.message)}</p></div>`;
  });
})();
