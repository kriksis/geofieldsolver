# Geocache Field Solver

An offline web app (PWA) for geocache field puzzles: multi-caches and mysteries where you
collect numbers on site and plug them into a formula. Enter each stage's answer as you go;
the final coordinates appear when everything is filled in. Values are saved on the phone as
you type, so a half-finished multi can be continued another day.

- Import a Pocket Query (`.zip` or `.gpx`) — field puzzles are detected automatically
  (tuned for Latvian listings) — or import `field-caches.json` prepared by Claude.
- Every imported GC code is remembered; later imports add only new caches.
- Weekly PQs: each cache remembers which PQ it came in (by the PQ's name, e.g. "LV 1k").
  When that PQ is imported again without it, the cache is marked "not in PQ" (archived or
  found by you) and moves to the **Gone?** filter; archived/disabled flags are refreshed too.
- A checker link (geocheck, certitude, geochecker …) from the listing is shown at the top of
  each cache (✓ in the title bar).
- Stages with distance, Go/compass view, Google/Apple Maps links.
- Checksums from the listing (✓/✗), projections (bearing + distance), Cyrillic and
  multi-letter variable names, digit-split values (`(A+B)*463 = STVXYZ`).
- Tags: on site, home/PC, film, jigidi, internet, ticket, boat, passport, night.
- "Done" list for caches you already solved (paste GC codes or import a list GPX).
- Everything stays in your browser (IndexedDB). Use **Export backup** to move devices.

## Use on your phone

The app lives in `docs/` and is published with GitHub Pages:
Settings → Pages → Branch `main`, folder `/docs`. Open the Pages URL on the phone and
choose "Add to Home screen". After the first visit it works offline.

Then copy `data/field-caches.json` to the phone (Drive, e-mail, cable) and import it on the
app's **＋** screen. This file is not in the repository on purpose (see below).

## New Pocket Queries

1. Put the PQ files in `data/pq/` and list them in `data/pq/index.json`.
2. Ask Claude to review the new caches; its verdicts go into `data/curation.txt`.
3. Run `tools/serve.ps1` and open http://localhost:8765/tools/build.html → **Build**.
   It writes `data/field-caches.json` and `data/registry.json` and lists any caches not
   yet reviewed or puzzle formulas with problems.
4. Import the new `field-caches.json` in the app — known caches keep your answers.

Local preview of the app: http://localhost:8765/docs/

## Privacy

`data/` is git-ignored: listings are written by cache owners and Pocket Query data is for
personal use, so it must not be published. GitHub Pages only serves the empty app.
