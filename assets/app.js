/**
 * The Mud Dawgs Association -- front end.
 *
 * Loads the committed snapshot (data/league.json) for an instant first paint,
 * then lets anyone pull live data straight from Sleeper with the Refresh button.
 * The refresh reuses the exact same client and transform modules the bake script
 * runs in Node -- there is only one implementation of the league logic.
 */

import { fetchLeagueHistory, getAllPlayers } from "../src/sleeper.js";
import { buildLeagueModel, collectPlayerIds } from "../src/transform.js";

const CACHE_KEY = "mud-dawgs:snapshot:v1";

/** In-memory state. `players` maps player_id -> { n: name, p: position, t: team }. */
const state = {
  model: null,
  players: {},
  config: {},
  view: "trades",
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const $ = (sel) => document.querySelector(sel);
const el = (id) => document.getElementById(id);

/** Escape text for interpolation into HTML. */
function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

const ORDINALS = ["", "1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th"];
const ordinal = (n) => ORDINALS[n] ?? `${n}th`;

const fmtPoints = (n) => Number(n ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function fmtDate(ms) {
  if (!ms) return "";
  return new Date(ms).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

/** Player id -> display name, falling back to the raw id if we have no record. */
function playerName(id) {
  const p = state.players[id];
  return p?.n ?? `Player ${id}`;
}

function playerPosition(id) {
  return state.players[id]?.p ?? null;
}

/** Franchise team name for a Sleeper user id. */
function franchiseName(ownerId) {
  if (!ownerId) return "Unknown";
  const f = state.model?.franchises.find((x) => x.ownerId === ownerId);
  return f?.teamName ?? "Unknown";
}

function franchiseManager(ownerId) {
  const f = state.model?.franchises.find((x) => x.ownerId === ownerId);
  return f?.displayName ?? "";
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function loadJSON(path) {
  const res = await fetch(path, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

/**
 * Prefer a locally refreshed snapshot over the committed one when it is newer.
 *
 * The Refresh button writes to localStorage, so a visitor who refreshes keeps
 * seeing live data on subsequent visits until the repo snapshot overtakes it.
 */
function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeCache(model, players) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ model, players }));
  } catch {
    // Quota exceeded on a very large league: not fatal, the page still works.
  }
}

async function boot() {
  el("refresh-btn").addEventListener("click", refresh);
  setupTabs();

  try {
    state.config = await loadJSON("./league.config.json");
  } catch {
    state.config = {};
  }

  let baked = null;
  try {
    const [model, players] = await Promise.all([
      loadJSON("./data/league.json"),
      loadJSON("./data/players.json"),
    ]);
    baked = { model, players };
  } catch {
    baked = null;
  }

  const cached = readCache();
  const useCache =
    cached?.model &&
    (!baked || new Date(cached.model.generatedAt) > new Date(baked.model.generatedAt));

  const chosen = useCache ? cached : baked;

  if (!chosen) {
    el("tagline").textContent = "No snapshot yet -- run the bake script, or hit Refresh.";
    el("refresh-btn").disabled = false;
    el("trade-list").innerHTML =
      '<div class="empty">Nothing baked yet.<br>Set your league id in <code>league.config.json</code> and run <code>npm run bake</code> -- or press <strong>Refresh from Sleeper</strong> to pull live.</div>';
    return;
  }

  state.model = chosen.model;
  state.players = chosen.players ?? {};
  el("refresh-btn").disabled = false;

  if (useCache) {
    setStatus(`Showing your refresh from ${fmtDate(new Date(chosen.model.generatedAt).getTime())}`, "ok");
  }

  renderAll();
}

// ---------------------------------------------------------------------------
// Refresh (live pull, in the browser)
// ---------------------------------------------------------------------------

function setStatus(msg, kind = "") {
  const node = el("refresh-status");
  node.className = `refresh-status ${kind}`;
  node.innerHTML = kind === "busy" ? `<span class="spin"></span>${esc(msg)}` : esc(msg);
}

/**
 * Pull the whole league live and re-render.
 *
 * This is read-only: Sleeper's API needs no key and this writes nothing back to
 * the repo, so it is safe to expose to anyone visiting the page. Persisting a
 * refresh for *everyone* is a separate, authenticated step -- the
 * `refresh-data` GitHub Action.
 */
async function refresh() {
  const leagueId = state.model?.currentLeagueId || state.config.leagueId;
  if (!leagueId || leagueId === "REPLACE_ME") {
    setStatus("No league id configured.", "error");
    return;
  }

  const btn = el("refresh-btn");
  btn.disabled = true;

  try {
    setStatus("Contacting Sleeper...", "busy");
    const history = await fetchLeagueHistory(leagueId, {
      onProgress: (msg) => setStatus(msg, "busy"),
    });

    const model = buildLeagueModel(history);

    // A refresh can surface players the trimmed dictionary has never seen.
    // Only then do we pay for the full ~5 MB player download, and we keep just
    // the entries this league needs.
    const wanted = collectPlayerIds(model, history);
    const unknown = [...wanted].filter((id) => !state.players[id]);

    if (unknown.length) {
      setStatus(`Resolving ${unknown.length} new players...`, "busy");
      const all = await getAllPlayers();
      for (const id of unknown) {
        const p = all[id];
        if (!p) continue;
        state.players[id] = {
          n: p.full_name || [p.first_name, p.last_name].filter(Boolean).join(" ") || "Unknown",
          p: p.position ?? null,
          t: p.team ?? null,
        };
      }
    }

    state.model = model;
    writeCache(model, state.players);
    renderAll();
    setStatus(`Updated just now -- ${model.trades.length} trades`, "ok");
  } catch (err) {
    const msg = /40\d/.test(err.message)
      ? `Sleeper does not recognise league ${leagueId}.`
      : `Refresh failed: ${err.message}`;
    setStatus(msg, "error");
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function setupTabs() {
  for (const tab of document.querySelectorAll(".tab")) {
    tab.addEventListener("click", () => {
      state.view = tab.dataset.view;
      for (const t of document.querySelectorAll(".tab")) {
        t.setAttribute("aria-selected", String(t === tab));
      }
      for (const v of document.querySelectorAll(".view")) {
        v.hidden = v.id !== `view-${state.view}`;
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderAll() {
  renderHeader();
  renderFilters();
  renderTrades();
  renderFranchises();
  renderSeasons();
  renderDrafts();
}

function renderHeader() {
  const m = state.model;
  const span = m.firstSeason === m.latestSeason ? m.firstSeason : `${m.firstSeason}–${m.latestSeason}`;
  el("tagline").textContent =
    `${m.leagueName} · ${span} · ${m.franchises.length} franchises · ${m.trades.length} trades`;
  el("footer-generated").textContent = `Snapshot generated ${new Date(m.generatedAt).toLocaleString()}`;
}

function renderFilters() {
  const m = state.model;

  const seasonSel = el("trade-season");
  const seasons = [...new Set(m.trades.map((t) => t.season))].sort((a, b) => Number(b) - Number(a));
  seasonSel.innerHTML =
    '<option value="">All seasons</option>' +
    seasons.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join("");

  const franchiseSel = el("trade-franchise");
  franchiseSel.innerHTML =
    '<option value="">All franchises</option>' +
    m.franchises
      .map((f) => `<option value="${esc(f.ownerId)}">${esc(f.teamName)}</option>`)
      .join("");

  for (const node of [seasonSel, franchiseSel]) {
    node.addEventListener("change", renderTrades);
  }
  el("trade-search").addEventListener("input", renderTrades);

  const draftSel = el("draft-season");
  draftSel.innerHTML = m.drafts
    .map((d) => `<option value="${esc(d.draftId)}">${esc(d.season)} draft</option>`)
    .join("");
  draftSel.addEventListener("change", renderDrafts);
}

/** Text blob for a trade, used by the search box. */
function tradeSearchText(trade) {
  const parts = [trade.season];
  for (const side of trade.sides) {
    parts.push(franchiseName(side.ownerId), franchiseManager(side.ownerId));
    for (const id of [...side.playersIn, ...side.playersOut]) parts.push(playerName(id));
    for (const pick of [...side.picksIn, ...side.picksOut]) {
      parts.push(`${pick.season} ${ordinal(pick.round)}`);
    }
  }
  return parts.join(" ").toLowerCase();
}

function renderTrades() {
  const m = state.model;
  const season = el("trade-season").value;
  const ownerId = el("trade-franchise").value;
  const query = el("trade-search").value.trim().toLowerCase();

  let trades = m.trades;
  if (season) trades = trades.filter((t) => t.season === season);
  if (ownerId) trades = trades.filter((t) => t.sides.some((s) => s.ownerId === ownerId));
  if (query) trades = trades.filter((t) => tradeSearchText(t).includes(query));

  el("trade-count").textContent =
    `${trades.length} of ${m.trades.length} trade${m.trades.length === 1 ? "" : "s"}`;

  el("trade-list").innerHTML = trades.length
    ? trades.map(tradeCard).join("")
    : '<div class="empty">No trades match those filters.</div>';
}

function assetList(heading, direction, items) {
  if (!items.length) return "";
  return `
    <div class="asset-group ${direction}">
      <div class="heading">${esc(heading)}</div>
      <ul class="assets">${items.join("")}</ul>
    </div>`;
}

/** A pick reads "2027 1st (via Creek Crew)" when it did not start with this team. */
function pickLabel(pick, holderOwnerId) {
  const via =
    pick.originalOwnerId && pick.originalOwnerId !== holderOwnerId
      ? ` <span style="color:var(--dim)">(via ${esc(franchiseName(pick.originalOwnerId))})</span>`
      : "";
  return `<li class="pick">${esc(pick.season)} ${esc(ordinal(pick.round))}${via}</li>`;
}

function playerLi(id) {
  const pos = playerPosition(id);
  const badge = pos ? `<span class="pos ${esc(pos)}">${esc(pos)}</span>` : "";
  return `<li>${badge}${esc(playerName(id))}</li>`;
}

function tradeSide(side) {
  const gotItems = [
    ...side.playersIn.map(playerLi),
    ...side.picksIn.map((p) => pickLabel(p, side.ownerId)),
    ...(side.faabIn ? [`<li class="faab">$${side.faabIn} FAAB</li>`] : []),
  ];
  const sentItems = [
    ...side.playersOut.map(playerLi),
    ...side.picksOut.map((p) => pickLabel(p, side.ownerId)),
    ...(side.faabOut ? [`<li class="faab">$${side.faabOut} FAAB</li>`] : []),
  ];

  return `
    <div class="side">
      <div class="side-team">${esc(franchiseName(side.ownerId))}</div>
      <div class="side-manager">${esc(franchiseManager(side.ownerId))}</div>
      ${assetList("Received", "in", gotItems)}
      ${assetList("Gave up", "out", sentItems)}
    </div>`;
}

function tradeCard(trade) {
  const week = trade.week ? `Week ${trade.week}` : "Offseason";
  return `
    <article class="trade">
      <div class="trade-head">
        <span><span class="season-chip">${esc(trade.season)}</span> &nbsp;${esc(week)}</span>
        <span class="when">${esc(fmtDate(trade.created))}</span>
      </div>
      <div class="trade-sides">${trade.sides.map(tradeSide).join("")}</div>
    </article>`;
}

function renderFranchises() {
  const m = state.model;

  const totalTrades = m.trades.length;
  const seasonsPlayed = m.seasons.length;
  const titles = m.seasons.filter((s) => s.championOwnerId).length;

  el("league-stats").innerHTML = [
    { label: "Seasons", value: seasonsPlayed },
    { label: "Franchises", value: m.franchises.length },
    { label: "Trades", value: totalTrades },
    { label: "Champions crowned", value: titles },
  ]
    .map((s) => `<div class="stat"><div class="value">${esc(s.value)}</div><div class="label">${esc(s.label)}</div></div>`)
    .join("");

  const rows = m.franchises
    .map((f) => {
      const c = f.career;
      const pct = c.wins + c.losses + c.ties ? c.wins / (c.wins + c.losses + c.ties) : 0;
      return `
        <tr>
          <td class="team">${esc(f.teamName)}${c.titles ? ` <span class="trophy" title="${c.titles} title(s)">${"★".repeat(c.titles)}</span>` : ""}</td>
          <td>${esc(f.displayName)}</td>
          <td class="num">${c.wins}-${c.losses}${c.ties ? `-${c.ties}` : ""}</td>
          <td class="num">${pct.toFixed(3).replace(/^0/, "")}</td>
          <td class="num">${esc(fmtPoints(c.pointsFor))}</td>
          <td class="num">${c.trades}</td>
          <td class="num">${c.seasons}</td>
        </tr>`;
    })
    .join("");

  el("franchise-tables").innerHTML = `
    <div class="table-card">
      <h3>All-time franchise records</h3>
      <div class="table-scroll">
        <table>
          <thead><tr>
            <th>Franchise</th><th>Manager</th><th class="num">Record</th><th class="num">Win %</th>
            <th class="num">Points for</th><th class="num">Trades</th><th class="num">Seasons</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
}

function renderSeasons() {
  const m = state.model;
  const seasons = [...m.seasons].sort((a, b) => Number(b.season) - Number(a.season));

  el("season-tables").innerHTML = seasons
    .map((s) => {
      const champ = s.championOwnerId
        ? `<span class="trophy">★ ${esc(franchiseName(s.championOwnerId))}</span>`
        : `<span style="color:var(--dim)">in progress</span>`;

      const rows = s.standings
        .map(
          (r, i) => `
          <tr>
            <td class="num">${i + 1}</td>
            <td class="team">${esc(r.teamName)}</td>
            <td class="num">${r.wins}-${r.losses}${r.ties ? `-${r.ties}` : ""}</td>
            <td class="num">${esc(fmtPoints(r.pointsFor))}</td>
            <td class="num">${esc(fmtPoints(r.pointsAgainst))}</td>
            <td class="num">${r.moves}</td>
          </tr>`
        )
        .join("");

      return `
        <div class="table-card">
          <h3><span>${esc(s.season)} &nbsp;<span style="color:var(--dim);font-weight:400">${s.tradeCount} trades</span></span>${champ}</h3>
          <div class="table-scroll">
            <table>
              <thead><tr>
                <th class="num">#</th><th>Team</th><th class="num">Record</th>
                <th class="num">PF</th><th class="num">PA</th><th class="num">Moves</th>
              </tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>`;
    })
    .join("");
}

function renderDrafts() {
  const m = state.model;
  if (!m.drafts.length) {
    el("draft-board").innerHTML = '<div class="empty">No draft data available.</div>';
    return;
  }

  const chosen = el("draft-season").value || m.drafts[0].draftId;
  const draft = m.drafts.find((d) => d.draftId === chosen) ?? m.drafts[0];

  const rows = draft.picks
    .map(
      (p) => `
      <tr>
        <td class="num">${p.round}.${String(p.pickNo).padStart(2, "0")}</td>
        <td class="team">${p.playerId ? playerLi(p.playerId).replace(/^<li>|<\/li>$/g, "") : "—"}</td>
        <td>${esc(franchiseName(p.ownerId))}</td>
        <td>${p.isKeeper ? "keeper" : ""}</td>
      </tr>`
    )
    .join("");

  el("draft-board").innerHTML = `
    <div class="table-card">
      <h3><span>${esc(draft.season)} draft</span><span style="color:var(--dim);font-weight:400">${esc(draft.type ?? "")} · ${draft.picks.length} picks</span></h3>
      <div class="table-scroll">
        <table>
          <thead><tr><th class="num">Pick</th><th>Player</th><th>Team</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
}

boot();
