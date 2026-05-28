# Demo samples (plug & play)

Official demonstration CSVs from the take-home assignment.

| File | Description |
|------|-------------|
| `user_transactions.csv` | User-side export (includes messy rows) |
| `exchange_transactions.csv` | Exchange-side export |

These files are used **by default** when `POST /reconcile` is called without `userCsvPath` / `exchangeCsvPath`.

Expected columns:

```
transaction_id,timestamp,type,asset,quantity,price_usd,fee,note
```
