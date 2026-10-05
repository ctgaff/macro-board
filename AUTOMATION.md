# Automating the Macro Board

The board reads `board.json` on load and every 5 minutes. A scheduled job rebuilds that file.

## Setup (GitHub, free)
1. Get a free FRED key: https://fred.stlouisfed.org/docs/api/api_key.html
2. Push this project to a GitHub repo. Add the key as a repo secret named `FRED_API_KEY`.
3. Enable GitHub Pages for the repo (serves `Macro Board.dc.html` + `board.json`).
4. Actions → "Update macro board" → Run workflow once to test. It then runs every 30 min on weekdays.

## Where each value comes from
- Actuals: FRED (GDP, retail sales, CPI, PPI, PCE, payrolls, unemployment, claims, ADP, JOLTS).
- Forecasts + upcoming calendar: ForexFactory weekly JSON feed (forecast is captured before release and kept after).
- ISM PMIs, Conference Board: no free API — edit `manual.json` after each release.

## Notes
- Some ForexFactory titles may not match a row (e.g. PPI/PCE are often m/m there). Adjust the `ff` regexes in `scripts/fetch-board.mjs`, or set the forecast in `manual.json`.
- Run locally: `FRED_API_KEY=xxx node scripts/fetch-board.mjs`
