# Notebook provenance and mapping (Task 4)

`notebook-mapping.json` is the machine-readable manifest. It records source
paths only as provenance; application code never reads those paths. Hashes are
kept so a future re-check can detect a changed source.

## Sources

| ID | Role | File SHA-256 | Cell-source SHA-256 | Defaults/differences |
| --- | --- | --- | --- | --- |
| `qqq_vix_dca` | primary | `6061d3b5cc1a7ae4746d09e608ab4173380cdd7fb50498bc89e088231fff0cdd` | `2ab790568d0d5d8d8b8077aba4382e7f771c1d6ff32395a71f349d60e01e8730` | QQQ, 2020-01-01→2027-01-01, day 1/100, safety 1200, `^VIX >= 25`, max 1 |
| `compare_strategies` | primary | `e748f2643a08522ffdf0a75969ad724ad37d6f1def43b79c8bbdd9ef0533acce` | `9930af3cdd8b0b09ced08cd529fe3ac876cb56fe9e689777644d17a2fc82dbec` | QQQ, 2022-05-01→2026-12-01, OR, fixed ratio .5, VIX/RSI/MA/Bollinger, exits, four grid dimensions |
| `qqq_vix_dca_copy_variant` | unreferenced variant (not a Task 4 source) | `34eadbbdb34de587f38876d44c51757bd31eca3d268897a8b782766ddf67d511` | `0f2d4ebfdecf08f8c1d1017263aa14ba0f447416a787d8377bdc0d46ea277e11` | Retained only in `unreferenced_sources`: 2018-05-01 start, 2026-12-01 end, threshold 30, and a SPY legend typo |

The first and third source hashes are the concatenated code-cell source. The
`compare_strategies` source hash is the SHA-256 of newline-joined cell source
strings. The full manifest records every explicit CONFIG key and its current
catalog mapping or retirement, including derived contracts (preset identity,
search dimensions, `rate.sourceUnit`, and the explicit Bollinger VIX ceiling).
The notebook's PE controls and ETF coverage threshold remain in the manifest
only as retired inputs; they have no active catalog mapping.

The former strategy-mode input maps to preset identity only. The current UI
always runs all added strategies; its scope parameter, selector, and state were
removed. The backend retains historical request compatibility.

## Normative V1 differences

The notebooks are historical inputs, not executable specifications. V1 does
not reproduce their conflicting behavior:

- The current market contract exposes the adjusted close used for simulation;
  it has no separate valuation-price contract.
- Missing VIX is unavailable; it is not forward-filled or silently skipped.
- The configured contribution day (1–31) and same-month exchange-calendar
  roll are used instead of `today.day <= 7`; partial ranges are not backfilled
  or prepaid.
- A close signal executes on the next trading day, not the same close. A
  final-day signal is retained as unexecuted.
- Actual exchange month-end drives the cash safety valve; a truncated final
  day is not treated as month-end.
- PE and ETF coverage inputs from the notebook are retired and have no runtime
  implementation. Macro observations retain their existing as-of rules.
- Phase 21 removes the notebook's fixed contribution ratio and its search
  dimension. Their provenance remains as `retiredInput` records without active
  parameter mappings. Monthly DCA and lump sum remain automatic benchmarks.

The `qqq_vix_dca_backtest copy` notebook is explicitly non-normative and is
retained only to explain the inventory discrepancy.

## Runtime data retrieval reference

The two primary notebooks obtain daily Yahoo data with `yfinance.download`,
using the configured symbol and inclusive start/exclusive end dates, with
`auto_adjust=False`; the VIX series is fetched separately and joined to QQQ.
Task 23 connects the same Yahoo source to the application through the existing
normalized adapter, which uses `Ticker.history` with the same date and price
adjustment settings. The notebook code is a retrieval reference; its VIX
forward-fill and permissive column fallback are not copied because the confirmed
data rules require missing observations to remain visible and unavailable.
