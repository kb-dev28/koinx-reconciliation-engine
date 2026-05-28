# Optional custom input

This folder is **empty by default** and is **not used** unless you pass custom paths in `POST /reconcile`.

For plug-and-play demo, the engine reads from `samples/` automatically.

To use your own files:

```json
{
  "userCsvPath": "data/user_transactions.csv",
  "exchangeCsvPath": "data/exchange_transactions.csv"
}
```

Paths may be absolute or relative to the process working directory.
