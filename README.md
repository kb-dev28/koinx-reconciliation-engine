# KoinX — Transaction Reconciliation Engine

Backend service that ingests **user** and **exchange** transaction CSVs, matches rows across sources with configurable tolerances, and produces an **audit-friendly CSV report** (Excel-ready).

**Plug & play:** clone, configure `.env`, run `npm start`, call `POST /reconcile` — demo CSVs are already in `samples/`.

---

## Quick start (evaluator-friendly)

```bash
# 1) Install
npm install

# 2) Configure MongoDB
cp .env.example .env
# Edit .env → set MONGO_URI

# 3) Start API
npm run start

# 4) Run reconciliation (uses samples/*.csv by default)
curl -s -X POST http://localhost:3000/reconcile \
  -H "Content-Type: application/json" \
  -d '{}'

# 5) Copy runId from response, then download report
curl -s "http://localhost:3000/report/<RUN_ID>" -o reconciliation-report.csv
```

Reports are also saved under `outputs/reconciliation-report-<RUN_ID>.csv`.

---

## Architecture

```mermaid
flowchart LR
  subgraph Input
    S[samples/user_transactions.csv]
    E[samples/exchange_transactions.csv]
    D[data/ optional custom CSVs]
  end

  subgraph API
    API[server.js]
  end

  subgraph Services
    I[ingestionService.js<br/>Part 1]
    M[matchingService.js<br/>Part 2]
    R[reconcileService.js<br/>Part 3 + orchestration]
  end

  subgraph Storage
    DB[(MongoDB)]
    OUT[outputs/*.csv]
  end

  S --> API
  E --> API
  D -. optional body paths .-> API
  API -->|POST /reconcile| R
  R --> I --> DB
  R --> M --> DB
  API -->|GET /report/:runId| R
  R --> OUT
```

### Pipeline (one `runId`)

1. **Ingestion** — parse CSV, normalize, flag invalid rows (never dropped), store `rawRow`.
2. **Matching** — pair user ↔ exchange (tolerances + type/asset rules).
3. **Report** — export CSV with categories, reasons, and original row JSON (UTF-8 BOM for Excel).

---

## Folder layout

| Folder | In Git | Purpose |
|--------|--------|---------|
| `samples/` | Yes (with CSVs) | **Default demo input** — plug & play |
| `data/` | Empty (`.gitkeep` only) | Optional folder if you want your own CSVs |
| `outputs/` | Empty (`.gitkeep` only) | **Auto-created** — generated reports |
| `config/` | Yes | Header + asset aliases |
| `services/` | Yes | Core business logic |
| `docs/internal/` | Ignored | Local notes (not submitted) |

### Input path resolution

When `POST /reconcile` **does not** include paths:

- `samples/user_transactions.csv`
- `samples/exchange_transactions.csv`

Paths are built with `path.join(__dirname, ...)` for **Windows / Linux / macOS** compatibility.

Optional body override:

```json
{
  "userCsvPath": "data/my_user.csv",
  "exchangeCsvPath": "data/my_exchange.csv"
}
```

---

## Prerequisites

- Node.js **18+**
- MongoDB (Atlas or local)

---

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MONGO_URI` | Yes | — | MongoDB connection string |
| `PORT` | No | `3000` | HTTP port |
| `TIMESTAMP_TOLERANCE_SECONDS` | No | `300` | ± seconds for timestamp match |
| `QUANTITY_TOLERANCE_PCT` | No | `0.01` | Quantity tolerance in **percent** |

---

## API reference

Base URL: `http://localhost:3000`

### Health

```bash
curl -s http://localhost:3000/health
```

### Run reconciliation

```bash
curl -s -X POST http://localhost:3000/reconcile \
  -H "Content-Type: application/json" \
  -d '{}'
```

With tolerance overrides:

```bash
curl -s -X POST http://localhost:3000/reconcile \
  -H "Content-Type: application/json" \
  -d '{
    "timestampToleranceSeconds": 300,
    "quantityTolerancePct": 0.01
  }'
```

### Full report (CSV download + file on disk)

```bash
curl -s "http://localhost:3000/report/<RUN_ID>" -o reconciliation-report.csv
```

Also written to: `outputs/reconciliation-report-<RUN_ID>.csv`

### Summary counts (pairs)

```bash
curl -s "http://localhost:3000/report/<RUN_ID>/summary"
```

### Unmatched rows only

```bash
curl -s "http://localhost:3000/report/<RUN_ID>/unmatched"
```

---

## Report format (auditor-friendly)

CSV columns include:

- `category` — Matched / Conflicting / Unmatched (User only) / Unmatched (Exchange only)
- `reason` — explanation
- Normalized user & exchange fields
- `user_original_row_json` / `exchange_original_row_json` — **RFC 4180 escaped** for Excel

UTF-8 **BOM** is included so Excel opens the file correctly on Windows.

---

## Design decisions

### UUID `runId`

Isolates each reconciliation run in MongoDB; safe for concurrent executions and audit trails.

### MongoDB

Flexible schema for messy data (`rawRow`, `errorReason`, reconciliation metadata) and efficient filtering by `runId`.

### Asset aliases (`bitcoin` → `BTC`)

Not ISO 20022 — this handles **messy export labels** in CSVs via `config/assetAliases.json` (extensible without code changes).

### Invalid rows

Never dropped. Stored with `isValid: false` and `errorReason`; included in the CSV report.

### Matching highlights

| Rule | Behavior |
|------|----------|
| Asset | Match after alias normalization |
| Type | Exact or `TRANSFER_OUT` ↔ `TRANSFER_IN` |
| Timestamp | Within ± configured seconds |
| Quantity | Within ± configured percent |
| Tie-break | Closest time, then closest quantity |

### Logging

Structured logs via `logger.js`:

```text
[2026-05-28T12:00:00.000Z] [INFO] Reconciliation run started {"runId":"...","userCsvPath":"..."}
```

---

## Scripts

| Command | Description |
|---------|-------------|
| `npm run start` | Start the API server |

---

## Author

Kaream Badillo — KoinX backend take-home submission.
