# KoinX — Transaction Reconciliation Engine

Backend service that ingests two CSV sources (user-exported and exchange-exported), matches transactions across them with configurable tolerances, and produces an audit-ready CSV report.

**Plug & play:** clone, set `MONGO_URI` in `.env`, run `npm start`, call `POST /reconcile` — demo CSVs are already in `samples/`.

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Set up environment
cp .env.example .env
# Open .env and set your MONGO_URI

# 3. Start the server
npm start

# 4. Trigger a reconciliation run (uses samples/*.csv by default)
curl -s -X POST http://localhost:3000/reconcile \
  -H "Content-Type: application/json" \
  -d '{}'

# 5. Download the report (replace <RUN_ID> with the id from the previous response)
curl -s "http://localhost:3000/report/<RUN_ID>" -o reconciliation-report.csv
```

---

## Prerequisites

- Node.js 18+
- MongoDB (Atlas free tier or local)

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `MONGO_URI` | Yes | — | MongoDB connection string |
| `PORT` | No | `3000` | HTTP port |
| `TIMESTAMP_TOLERANCE_SECONDS` | No | `300` | Matching window in seconds (± 5 min) |
| `QUANTITY_TOLERANCE_PCT` | No | `0.01` | Quantity tolerance in percent |

---

## How a run works

When you call `POST /reconcile`, the response includes a `runId` (UUID). That identifier groups every transaction ingested and matched in that execution. Use the same `runId` in all subsequent report endpoints — for example `GET /report/:runId`, `GET /report/:runId/summary`, and `GET /report/:runId/unmatched`.

---

## API Reference

Base URL: `http://localhost:3000`

### Health check

```bash
GET /health
```

### Trigger a reconciliation run

```bash
POST /reconcile
Content-Type: application/json
```

Tolerance values can also be overridden per-request via the request body (`timestampToleranceSeconds`, `quantityTolerancePct`).

Optional body fields: `userCsvPath`, `exchangeCsvPath`, `timestampToleranceSeconds`, `quantityTolerancePct`.

Response:
```json
{
  "runId": "a1b2c3...",
  "summary": {
    "matched": 18,
    "conflicting": 2,
    "unmatchedUser": 3,
    "unmatchedExchange": 2
  }
  // values depend on the input CSVs
}
```

### Full reconciliation report

```bash
GET /report/:runId
```

Returns a UTF-8 BOM CSV file (Excel-compatible), also saved to `outputs/reconciliation-report-<runId>.csv`.

### Summary counts

```bash
GET /report/:runId/summary
```

Returns matched / conflicting / unmatched counts as JSON.

### Unmatched rows only

```bash
GET /report/:runId/unmatched
```

Returns only rows with no counterpart, with the reason for each.

---

## Report Format

Each row in the CSV includes:

| Column | Description |
|---|---|
| `category` | `Matched`, `Conflicting`, `Unmatched (User only)`, `Unmatched (Exchange only)` |
| `reason` | Human-readable explanation |
| Normalised user fields | `user_timestamp`, `user_type`, `user_asset`, `user_quantity`, … |
| Normalised exchange fields | Same, for exchange side |
| `user_original_row_json` | Raw CSV row as ingested (RFC 4180 escaped) |
| `exchange_original_row_json` | Raw CSV row from exchange side |

---

## Folder Layout

```
├── config/
│   ├── assetAliases.json       # maps messy CSV labels to canonical symbols (e.g. "bitcoin" → "BTC", "Ethereum" → "ETH")
│   └── csvHeaderAliases.json   # tolerates non-standard CSV column names
├── data/                       # optional — place custom CSVs here
├── outputs/                    # auto-created — generated reports go here
├── samples/                    # default demo CSVs (committed)
│   ├── user_transactions.csv
│   └── exchange_transactions.csv
└── services/
    ├── ingestionService.js     # Part 1 — CSV parse, validate, persist
    ├── matchingService.js      # Part 2 — matching algorithm
    └── reconcileService.js     # Part 3 — orchestration, report, summary
```

---

## Architecture

One `runId` (UUID) ties all records from a single execution together, making runs isolated and safe for concurrent use.

```
POST /reconcile
      │
      ▼
reconcileService ──► ingestionService  →  MongoDB  (both CSVs stored)
      │
      └──────────► matchingService    →  MongoDB  (statuses updated)
      │
      └──────────► generateReportCsv  →  outputs/*.csv
```

---

## Design Decisions

### Unclear requirements and how they were resolved

**What happens to invalid rows?**
The assignment says "do not silently drop bad rows." All invalid rows are stored in MongoDB with `isValid: false` and an `errorReason` string explaining the problem. They appear in the report under their category with the reason visible.

Invalid rows are excluded from matching (you cannot reliably match a row with a missing timestamp or a null quantity) but they are never deleted.

**Duplicate rows (`USR-001` appears twice in the user CSV)**
The same `externalId + source` combination within a run is treated as a duplicate. The second occurrence is flagged with `isValid: false` and `errorReason: "Duplicate externalId"` and skipped during matching.

**Negative quantities (`USR-019` has quantity `-0.1`)**
A transaction with a negative or zero quantity is physically meaningless in this domain. It is flagged as invalid and excluded from matching.

**Malformed timestamps (`USR-018` has `2024-03-09T`, `USR-024` is empty)**
Any row whose timestamp cannot be parsed to a valid `Date` is flagged as invalid. The raw string is preserved in `rawRow` for audit.

**`TRANSFER_OUT` vs `TRANSFER_IN` — same event, opposite perspective**
The user records sending ETH as `TRANSFER_OUT`; the exchange records receiving it as `TRANSFER_IN`. The matching engine treats these as compatible types. Any other type pair must match exactly.

**Asset aliases (`bitcoin` → `BTC`)**
Normalisation is config-driven via `config/assetAliases.json`. New aliases can be added without touching code.

**`externalId` is not unique**
IDs from the CSVs are not assumed to be globally unique. They can be absent, duplicated within a source, or collide across sources. Matching is done by proximity (asset + type + timestamp window + quantity tolerance), not by ID.

**Matching tie-break**
When two exchange candidates satisfy all tolerances for the same user row, the engine picks the one closest in time first, then closest in quantity. This is deterministic and auditable.

**Why MongoDB?**
The data is intentionally messy. A flexible document store lets each row carry a `rawRow` blob and arbitrary `errorReason` strings without a rigid schema migration. It also makes filtering by `runId`, `source`, and `reconciliationStatus` straightforward with compound indexes.

**`runId` as UUID**
Each reconciliation run gets an isolated UUID. This means the same CSVs can be re-processed without overwriting previous results, which is essential for an audit trail.

---

## Scripts

| Command | Description |
|---|---|
| `npm start` | Start the API server |

---

## Author

Kaream Badillo — KoinX backend take-home submission.