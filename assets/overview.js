/**
 * The Overview tab: league-wide stats, charts, records and projections.
 *
 * Charts are CSS boxes rather than SVG wherever the shape is a bar, because
 * bars reflow with their container for free and pick up the theme tokens. The
 * weekly trend is genuinely a path, so that one is inline SVG.
 *
 * Rendering helpers are passed in rather than imported, so this module has no
 * dependency back on app.js.
 */

/** Percent with one decimal, e.g. 86.3%. */
const pct = (n) => `${(n * 100).toFixed(1)}%`;

/** Wrap content in the standard card shell. */
function card(title, aside, body) {
  return `
    <div class="table-card">
      <h3><span>${title}</span>${aside ? `<span style="color:var(--dim);font-weight:400">${aside}</span>` : ""}</h3>
      ${body}
    </div>`;
}

/**
 * Render everything in the Overview tab.
 *
 * `h` carries the shared formatting helpers from app.js.
 */
export function renderOverview(model, h) {
  const a = model.analytics;
  if (!a) return;

  renderStats(model, a, h);
  renderProjection(model, a, h);
  renderLuck(a, h);
  renderPower(a, h);
  renderTrend(model, a, h);
  renderTradesChart(model, h);
  renderTitles(model, h);
  renderRecords(a, h);
  renderHeadToHead(model, a, h);
}

// ---------------------------------------------------------------------------

function renderStats(model, a, h) {
  const rec = a.records;
  const favorite = a.projection?.results?.[0];
  const totalGames = a.allPlay.reduce((s, r) => s + r.actualWins + r.actualLosses, 0) / 2;

  const tiles = [
    { label: "Seasons", value: model.seasons.length },
    { label: "Games played", value: Math.round(totalGames) },
    { label: "Trades", value: model.trades.length },
    { label: "Highest score", value: rec ? rec.highestScore.points.toFixed(1) : "—" },
    {
      label: `${a.projection?.season ?? ""} favorite`.trim(),
      value: favorite ? pct(favorite.playoffOdds) : "—",
      sub: favorite ? h.franchiseName(favorite.ownerId) : "",
    },
  ];

  document.getElementById("ov-stats").innerHTML = tiles
    .map(
      (t) => `<div class="stat">
        <div class="value">${h.esc(t.value)}</div>
        <div class="label">${h.esc(t.label)}</div>
        ${t.sub ? `<div class="label" style="text-transform:none;letter-spacing:0;color:var(--accent-soft);margin-top:2px">${h.esc(t.sub)}</div>` : ""}
      </div>`
    )
    .join("");
}

// ---------------------------------------------------------------------------

function renderProjection(model, a, h) {
  const p = a.projection;
  const node = document.getElementById("ov-projection");

  if (!p) {
    node.innerHTML = "";
    return;
  }

  const rows = p.results
    .map((r, i) => {
      const cut = i === p.playoffTeams - 1 ? " class=\"cut\"" : "";
      const fill = r.playoffOdds >= 0.5 ? "" : " dim";
      return `
        <tr${cut}>
          <td class="num">${i + 1}</td>
          <td class="team">${h.esc(h.franchiseName(r.ownerId))}</td>
          <td class="num">${r.currentWins}</td>
          <td class="num">${r.projectedWins.toFixed(1)}</td>
          <td>
            <div class="odds">
              <div class="bar-track"><div class="bar-fill${fill}" style="width:${(r.playoffOdds * 100).toFixed(1)}%"></div></div>
              <span class="pct">${pct(r.playoffOdds)}</span>
            </div>
          </td>
          <td class="num">${r.averageSeed.toFixed(1)}</td>
          <td class="num">${r.mean.toFixed(1)}</td>
        </tr>`;
    })
    .join("");

  const played = p.gamesPlayed > 0;
  const basis = played
    ? `${p.gamesPlayed} games played, ${p.gamesRemaining} to go`
    : `season not started — based on prior scoring`;

  node.innerHTML = card(
    `${h.esc(p.season)} projection`,
    h.esc(basis),
    `<div class="table-scroll">
      <table>
        <thead><tr>
          <th class="num">#</th><th>Team</th><th class="num">W</th><th class="num">Proj W</th>
          <th>Playoff odds</th><th class="num">Avg seed</th><th class="num">PPG</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="chart-note">
      ${p.sims.toLocaleString()} Monte Carlo simulations of the remaining schedule. Each team's weekly
      score is drawn from its own scoring distribution, weighted toward recent seasons. The line marks
      the ${p.playoffTeams}-team playoff cut. Simulations are seeded, so these numbers only move when
      the league does.
    </p>`
  );
}

// ---------------------------------------------------------------------------

function renderLuck(a, h) {
  const rows = [...a.allPlay].sort((x, y) => y.luck - x.luck);
  const max = Math.max(...rows.map((r) => Math.abs(r.luck)), 0.01);

  const bars = rows
    .map((r) => {
      const width = (Math.abs(r.luck) / max) * 50; // half-width each side
      const side = r.luck >= 0 ? "pos" : "neg";
      return `
        <div class="bar-row">
          <span class="bar-label">${h.esc(h.franchiseName(r.ownerId))}</span>
          <div class="diverge-track">
            <div class="diverge-fill ${side}" style="width:${width.toFixed(2)}%"></div>
          </div>
          <span class="bar-value" style="color:${r.luck >= 0 ? "var(--good)" : "var(--bad)"}">
            ${r.luck >= 0 ? "+" : ""}${(r.luck * 100).toFixed(1)}
          </span>
        </div>`;
    })
    .join("");

  document.getElementById("ov-luck").innerHTML = card(
    "Luck",
    "actual vs all-play",
    `${bars}
     <p class="chart-note">
       All-play asks how a team would have done against the entire league each week, not just the one
       opponent the schedule gave it. Green means the schedule was kind; red means the team scored
       better than its record shows.
     </p>`
  );
}

// ---------------------------------------------------------------------------

function renderPower(a, h) {
  const rows = a.powerRatings;
  if (!rows.length) return;
  const max = Math.max(...rows.map((r) => r.mean));
  const min = Math.min(...rows.map((r) => r.mean)) * 0.9;

  const bars = rows
    .map(
      (r) => `
      <div class="bar-row">
        <span class="bar-label">${h.esc(h.franchiseName(r.ownerId))}</span>
        <div class="bar-track">
          <div class="bar-fill" style="width:${(((r.mean - min) / (max - min)) * 100).toFixed(1)}%"></div>
        </div>
        <span class="bar-value">${r.mean.toFixed(1)}</span>
      </div>`
    )
    .join("");

  document.getElementById("ov-power").innerHTML = card(
    "Scoring power",
    "weighted PPG",
    `${bars}
     <p class="chart-note">
       Average points per week, weighting each season twice as heavily as the one before it — a roster
       from three years ago says much less about today than last season does. This is the input to the
       projection above.
     </p>`
  );
}

// ---------------------------------------------------------------------------

/** League-average score by week, for the most recent season with real results. */
function renderTrend(model, a, h) {
  const withScores = [...a.weeklyBySeason].reverse().find((s) => s.scores.length > 0);
  const node = document.getElementById("ov-trend");
  if (!withScores) {
    node.innerHTML = "";
    return;
  }

  const byWeek = new Map();
  for (const s of withScores.scores) {
    if (!byWeek.has(s.week)) byWeek.set(s.week, []);
    byWeek.get(s.week).push(s.points);
  }

  const weeks = [...byWeek.keys()].sort((x, y) => x - y);
  const series = weeks.map((w) => {
    const v = byWeek.get(w);
    return {
      week: w,
      avg: v.reduce((s, n) => s + n, 0) / v.length,
      hi: Math.max(...v),
      lo: Math.min(...v),
    };
  });

  const W = 640;
  const H = 210;
  const PAD = { l: 38, r: 12, t: 14, b: 24 };
  const lo = Math.min(...series.map((s) => s.lo));
  const hi = Math.max(...series.map((s) => s.hi));
  const x = (i) => PAD.l + (i / Math.max(series.length - 1, 1)) * (W - PAD.l - PAD.r);
  const y = (v) => PAD.t + (1 - (v - lo) / Math.max(hi - lo, 1)) * (H - PAD.t - PAD.b);

  const line = series.map((s, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(s.avg).toFixed(1)}`).join(" ");
  const band =
    series.map((s, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(s.hi).toFixed(1)}`).join(" ") +
    " " +
    series
      .map((s, i) => `L${x(series.length - 1 - i).toFixed(1)},${y(series[series.length - 1 - i].lo).toFixed(1)}`)
      .join(" ") +
    " Z";

  const ticks = [lo, (lo + hi) / 2, hi];
  const gridlines = ticks
    .map(
      (t) => `<line class="grid-line" x1="${PAD.l}" y1="${y(t).toFixed(1)}" x2="${W - PAD.r}" y2="${y(t).toFixed(1)}"/>
              <text class="axis-text" x="4" y="${(y(t) + 3).toFixed(1)}">${Math.round(t)}</text>`
    )
    .join("");

  const labels = series
    .filter((_, i) => i % 2 === 0)
    .map((s, i2) => {
      const i = i2 * 2;
      return `<text class="axis-text" text-anchor="middle" x="${x(i).toFixed(1)}" y="${H - 6}">${s.week}</text>`;
    })
    .join("");

  const dots = series.map((s, i) => `<circle class="dot" cx="${x(i).toFixed(1)}" cy="${y(s.avg).toFixed(1)}" r="2.5"/>`).join("");

  node.innerHTML = card(
    `${h.esc(withScores.season)} scoring by week`,
    "league average, with weekly range",
    `<div class="trend" style="padding:8px 16px 0">
       <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="League average score by week">
         ${gridlines}
         <path class="band" d="${band}"/>
         <path class="series" d="${line}"/>
         ${dots}
         ${labels}
       </svg>
     </div>
     <p class="chart-note">
       The line is the league average each week; the shaded band spans the lowest and highest score
       posted that week.
     </p>`
  );
}

// ---------------------------------------------------------------------------

function renderTradesChart(model, h) {
  const seasons = [...model.seasons].sort((a, b) => Number(a.season) - Number(b.season));
  const max = Math.max(...seasons.map((s) => s.tradeCount), 1);

  const bars = seasons
    .map(
      (s) => `
      <div class="vbar">
        <span class="n">${s.tradeCount}</span>
        <div class="col" style="height:${Math.max((s.tradeCount / max) * 100, 1.5)}%"></div>
        <span class="k">${h.esc(s.season)}</span>
      </div>`
    )
    .join("");

  document.getElementById("ov-trades-chart").innerHTML = card(
    "Trades per season",
    `${model.trades.length} all time`,
    `<div class="vbars">${bars}</div>`
  );
}

// ---------------------------------------------------------------------------

function renderTitles(model, h) {
  const rows = [...model.seasons]
    .sort((a, b) => Number(b.season) - Number(a.season))
    .map((s) => {
      const champ = s.championOwnerId
        ? `<span class="trophy">★</span> ${h.esc(h.franchiseName(s.championOwnerId))}`
        : `<span style="color:var(--dim)">in progress</span>`;
      const top = s.standings[0];
      return `
        <tr>
          <td class="num">${h.esc(s.season)}</td>
          <td class="team">${champ}</td>
          <td class="team" style="color:var(--muted)">${h.esc(top?.teamName ?? "—")}</td>
          <td class="num">${s.tradeCount}</td>
        </tr>`;
    })
    .join("");

  document.getElementById("ov-titles").innerHTML = card(
    "Champions",
    "",
    `<div class="table-scroll">
      <table>
        <thead><tr><th class="num">Season</th><th>Champion</th><th>Best record</th><th class="num">Trades</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="chart-note">
      The champion is taken from the playoff bracket, so it is who actually won the title — not
      whoever finished first in the regular season.
    </p>`
  );
}

// ---------------------------------------------------------------------------

function renderRecords(a, h) {
  const r = a.records;
  const node = document.getElementById("ov-records");
  if (!r) {
    node.innerHTML = "";
    return;
  }

  const items = [
    ["Highest score", r.highestScore],
    ["Lowest score", r.lowestScore],
    ["Biggest blowout", r.biggestBlowout],
    ["Narrowest win", r.narrowestWin],
    ["Highest-scoring loss", r.highestScoringLoss],
    ["Lowest-scoring win", r.lowestScoringWin],
  ].filter(([, v]) => v);

  const body = items
    .map(
      ([label, v]) => `
      <div class="record">
        <div class="k">${h.esc(label)}</div>
        <div class="v">${v.points.toFixed(2)}<span style="color:var(--dim);font-size:13px;font-weight:400"> vs ${v.opponentPoints.toFixed(2)}</span></div>
        <div class="who">${h.esc(h.franchiseName(v.ownerId))}</div>
        <div class="when">${h.esc(v.season)} · week ${v.week} · vs ${h.esc(h.franchiseName(v.opponentOwnerId))}</div>
      </div>`
    )
    .join("");

  node.innerHTML = card("Record book", "regular season, all time", `<div class="record-list">${body}</div>`);
}

// ---------------------------------------------------------------------------

function renderHeadToHead(model, a, h) {
  const franchises = model.franchises;
  const index = new Map();
  for (const r of a.headToHead) index.set(`${r.ownerId}|${r.opponentOwnerId}`, r);

  const head = franchises
    .map((f) => `<th title="${h.esc(f.teamName)}">${h.esc(initials(f.teamName))}</th>`)
    .join("");

  const rows = franchises
    .map((rowF) => {
      const cells = franchises
        .map((colF) => {
          if (rowF.ownerId === colF.ownerId) return `<td class="self">—</td>`;
          const rec = index.get(`${rowF.ownerId}|${colF.ownerId}`);
          if (!rec) return `<td></td>`;
          const games = rec.wins + rec.losses + rec.ties;
          const share = games ? rec.wins / games : 0;
          // Tint toward green above .500 and red below, strength by margin.
          const strength = Math.min(Math.abs(share - 0.5) * 2, 1) * 0.4;
          const colour =
            share > 0.5
              ? `rgba(63, 185, 80, ${strength.toFixed(2)})`
              : share < 0.5
                ? `rgba(248, 81, 73, ${strength.toFixed(2)})`
                : "var(--bg-2)";
          return `<td style="background:${colour};color:var(--text)" title="${h.esc(rowF.teamName)} vs ${h.esc(colF.teamName)}">${rec.wins}-${rec.losses}</td>`;
        })
        .join("");
      return `<tr><th class="rowhead" title="${h.esc(rowF.teamName)}">${h.esc(rowF.teamName)}</th>${cells}</tr>`;
    })
    .join("");

  document.getElementById("ov-h2h").innerHTML = card(
    "Head to head",
    "row team's record vs column team",
    `<div class="table-scroll">
      <table class="h2h">
        <thead><tr><th></th>${head}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="chart-note">Regular-season meetings only. Green means the row team leads the series.</p>`
  );
}

/** Compact column label: initials of the team name, up to three characters. */
function initials(name) {
  const words = String(name).split(/\s+/).filter(Boolean);
  return words.map((w) => w[0]).join("").slice(0, 3).toUpperCase();
}
