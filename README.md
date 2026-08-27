# 🐾 The Mud Dawgs Association

A dynasty fantasy football league tracker. Every trade, every draft, every season
standing since the league began — pulled from [Sleeper](https://sleeper.app) and
published as a static site.

Dynasty leagues accumulate history that Sleeper's own app makes hard to look back
through: a pick traded three years ago, who actually won a deal, what a franchise's
all-time record is. This keeps all of it in one place.

**Overview** — playoff projections, luck, scoring power, records, head-to-head.
**Trades** — every deal ever, searchable, with pick provenance and FAAB.
**Franchises** — all-time records and titles. **Seasons** — standings and champions.
**Drafts** — full boards.

## Quick start

```bash
npm run bake -- <your-league-id>
```

Then open it locally:

```bash
npm run serve
```

There is nothing to install. The project has **zero dependencies** and no build
step — Node's built-in `fetch` and the browser's native ES modules do the work.

### Finding your league id

Open the league on Sleeper and copy the number out of the URL:

```
https://sleeper.app/leagues/123456789012345678/team
                            ^^^^^^^^^^^^^^^^^^
```

Any season's id works — the bake script walks `previous_league_id` backwards to
find every year the league has existed. Put it in `league.config.json` so you
don't have to pass it each time.

## How it works

```
league.config.json    your league id
src/sleeper.js        Sleeper API client        ─┐ shared, isomorphic:
src/transform.js      raw payloads → the model   │ same code in Node
src/analytics.js      luck, records, projections ─┘ and in the browser
scripts/bake.mjs      writes the snapshot
data/league.json      the committed snapshot the site renders
data/players.json     player names, trimmed to only this league's players
index.html            the site
assets/app.js         rendering + the Refresh button
assets/overview.js    the Overview tab: charts, records, projections
```

The important detail is that **`src/` runs in both places.** `scripts/bake.mjs`
imports it under Node to write the committed snapshot; `assets/app.js` imports
the very same modules in the browser for the Refresh button. There is one
implementation of the league logic, not two that can drift apart.

### Two things worth knowing

**`roster_id` is per-season; `owner_id` is forever.** Sleeper identifies teams
within a season by `roster_id`, and those numbers get reassigned between years —
roster 1 in 2024 may be a different manager in 2025. Every roster reference is
resolved through that season's roster list to a Sleeper `owner_id`, which is what
makes "this manager has made 34 trades since 2019" correct rather than nonsense.

**The player dictionary is trimmed.** Sleeper's full NFL player list is about
5 MB, far too much to ship to a browser on every page load. The bake step
downloads it once and keeps only the players this league has actually touched.

## Projections

The Overview tab projects the current season by Monte Carlo: 10,000 simulations of
the remaining schedule, drawing each team's weekly score from its own
normal(mean, stdev) profile built from past weekly scores, weighted so each season
counts twice as much as the one before it. Games already played are taken as fact;
only unplayed pairings are simulated. Seeding follows Sleeper's default of wins,
then total points.

Two things make the output trustworthy rather than decorative:

- **Sleeper publishes the schedule before it is played**, with points of 0. Those
  rows are flagged unplayed and never counted as real 0-point games.
- **The simulation is seeded.** Identical inputs give identical numbers, so the
  weekly refresh only commits when the league actually changed — not because the
  random draws moved.

Luck is measured as actual win% minus *all-play* win% — how a team would have done
against the entire league each week rather than the one opponent it drew.

## Refreshing the data

There are two refreshes, and they do different things.

| | Refresh button | `Refresh league data` workflow |
|---|---|---|
| Who can use it | anyone viewing the site | anyone with write access to this repo |
| What it changes | what **you** see, in your browser | what **everyone** sees |
| How it's gated | not gated — it's read-only | GitHub authentication |

The **Refresh button** pulls live from Sleeper in your browser and caches the
result in `localStorage`. Sleeper's read API needs no key and sends
`access-control-allow-origin: *`, so the page can call it directly with no server
involved. It writes nothing back to the repo, so there is nothing to protect.

To update the published snapshot for everyone, run the **Refresh league data**
workflow from the Actions tab, or let the schedule do it: **Wednesdays at
6:00 AM Central**, a few hours after the league's waivers clear (~2:05 AM CT
Wednesday), so the snapshot picks up that week's waiver moves. It commits a new
`data/league.json`, which redeploys the site automatically.

GitHub's cron is UTC and ignores daylight saving, but a fantasy season straddles
the November changeover — so the workflow fires at both 11:00 and 12:00 UTC and a
guard job drops whichever one isn't actually 6 AM in Chicago.

> A note on passwords: a static site can't keep a secret. Anything used to gate a
> button in client-side code is visible to anyone who opens View Source, so a
> password there is decoration, not security. Putting the write behind GitHub
> Actions gives a real gate — GitHub checks who you are — without pretending.

## Publishing

Settings → Pages → deploy from branch `main`, folder `/ (root)`. No build step,
so it just serves.

## Tests

```bash
node --test
```

The transform logic is pinned down with synthetic Sleeper payloads — flat
`adds`/`drops` maps, picks carrying `previous_owner_id`, roster ids that change
meaning between seasons — so the tricky regrouping is verified without needing
the live API.
