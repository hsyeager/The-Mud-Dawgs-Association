#!/usr/bin/env node
/**
 * Pull the league's full history from Sleeper and write the committed snapshot.
 *
 *   npm run bake                 # league id from league.config.json
 *   npm run bake -- 123456789    # or pass one explicitly
 *
 * Writes:
 *   data/league.json    the model the site renders
 *   data/players.json   player names, trimmed to only players this league touched
 *
 * The trim matters: Sleeper's player dictionary is ~5 MB, which is far too big to
 * ship to a browser on every page load. A league that has touched ~1500 players
 * ends up around 100 KB.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { fetchLeagueHistory, getAllPlayers } from "../src/sleeper.js";
import { buildLeagueModel, collectPlayerIds } from "../src/transform.js";
import { fetchKtcPlayers, matchKtcValues, isSuperflex } from "../src/ktc.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = resolve(ROOT, "league.config.json");
const DATA_DIR = resolve(ROOT, "data");

/** Fields the site actually needs. Everything else in a Sleeper player is dropped. */
function trimPlayer(p) {
  const name =
    p.full_name || [p.first_name, p.last_name].filter(Boolean).join(" ") || p.last_name || "Unknown";
  return {
    n: name,
    p: p.position ?? null,
    t: p.team ?? null,
  };
}

async function readConfig() {
  try {
    return JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

async function main() {
  const config = await readConfig();
  const leagueId = process.argv[2] || config.leagueId;

  if (!leagueId || leagueId === "REPLACE_ME") {
    console.error(
      [
        "No league id.",
        "",
        "Set it in league.config.json, or pass it:  npm run bake -- <leagueId>",
        "",
        "To find it: open the league on sleeper.app and copy the number out of",
        "the URL, e.g. https://sleeper.app/leagues/123456789012345678/team",
      ].join("\n")
    );
    process.exit(1);
  }

  const started = Date.now();
  console.log(`Pulling league ${leagueId} from Sleeper...`);

  const history = await fetchLeagueHistory(leagueId, {
    onProgress: (msg) => console.log(`  ${msg}`),
  });

  const model = buildLeagueModel(history);

  console.log("Trimming the NFL player dictionary...");
  const wanted = collectPlayerIds(model, history);
  const allPlayers = await getAllPlayers();

  const players = {};
  let missing = 0;
  for (const id of wanted) {
    const p = allPlayers[id];
    if (p) players[id] = trimPlayer(p);
    else missing += 1;
  }

  // KeepTradeCut dynasty values. Node only -- KTC sends no CORS header, so the
  // browser's Refresh button cannot fetch it and reuses whatever was last baked.
  // A KTC outage degrades the values column; it never fails the bake.
  const superflex = isSuperflex(model.seasons.at(-1)?.rosterPositions ?? []);
  const ktcPlayers = await fetchKtcPlayers({ onProgress: (m) => console.log(`  ${m}`) });

  let ktc = { fetchedAt: null, format: superflex ? "superflex" : "1qb", values: {} };
  if (ktcPlayers.length) {
    const matched = matchKtcValues(ktcPlayers, players, Object.keys(players), { superflex });
    ktc = { fetchedAt: new Date().toISOString(), format: matched.format, values: matched.values };
    console.log(
      `  KTC matched ${matched.matched}/${Object.keys(players).length}` +
        (matched.unmatched.length ? `, ${matched.unmatched.length} outside their top 500` : "")
    );
  }

  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(resolve(DATA_DIR, "league.json"), JSON.stringify(model, null, 2) + "\n");
  await writeFile(resolve(DATA_DIR, "players.json"), JSON.stringify(players) + "\n");
  await writeFile(resolve(DATA_DIR, "ktc.json"), JSON.stringify(ktc) + "\n");

  const seasons = model.seasons.map((s) => s.season).join(", ");
  console.log("");
  console.log(`  league     ${model.leagueName}`);
  console.log(`  seasons    ${model.seasons.length} (${seasons})`);
  console.log(`  franchises ${model.franchises.length}`);
  console.log(`  trades     ${model.trades.length}`);
  console.log(`  drafts     ${model.drafts.length}`);
  console.log(`  players    ${Object.keys(players).length}${missing ? ` (${missing} unresolved)` : ""}`);
  console.log(`  ktc        ${Object.keys(ktc.values).length} valued (${ktc.format})`);
  console.log(`  done in    ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error("\nBake failed:", err.message);
  process.exit(1);
});
