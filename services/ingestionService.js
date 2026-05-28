const fs = require('fs');
const csv = require('csv-parser');
const Transaction = require('../models/Transaction');
const assetAliases = require('../config/assetAliases.json');

/**
 * CSV headers can vary by source/export and can be messy.
 * This helper reads a value by trying multiple candidate header names.
 */
function pickField(row, candidates) {
  for (const key of candidates) {
    if (row && Object.prototype.hasOwnProperty.call(row, key) && row[key] !== undefined && row[key] !== null) {
      return row[key];
    }
  }
  return undefined;
}

function normaliseString(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s.length ? s : null;
}

function normaliseAsset(raw) {
  const asset = normaliseString(raw);
  if (!asset) return null;
  const upper = asset.toUpperCase();

  // Alias resolution (kept in config to support new datasets without code changes).
  const mapped = assetAliases[upper];
  if (mapped) return String(mapped).trim().toUpperCase();

  return upper;
}

function normaliseType(raw) {
  const type = normaliseString(raw);
  return type ? type.toUpperCase() : null;
}

const processCSV = async (filePath, source, runId) => {
  const results = [];

  return new Promise((resolve, reject) => {
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (data) => {
        // Ingestion: normalize + validate per-row (do not drop invalid rows).
        let isValid = true;
        const reasons = [];

        // Prefer canonical headers (snake_case) but tolerate common variants.
        const externalIdRaw = pickField(data, ['transaction_id', 'Transaction ID', 'transactionId']);
        const timestampRaw = pickField(data, ['timestamp', 'Timestamp' ]);
        const typeRaw = pickField(data, ['type', 'Type']);
        const assetRaw = pickField(data, ['asset', 'Asset' ]);
        const quantityRaw = pickField(data, ['quantity', 'Quantity' ]);

        const externalId = normaliseString(externalIdRaw);
        const type = normaliseType(typeRaw);
        const asset = normaliseAsset(assetRaw);

        // Quantity
        const quantityParsed = quantityRaw === undefined ? NaN : Number.parseFloat(String(quantityRaw).trim());
        const quantity = Number.isFinite(quantityParsed) ? quantityParsed : null;
        if (quantity === null) {
          isValid = false;
          reasons.push('Invalid quantity');
        } else if (quantity < 0) {
          isValid = false;
          reasons.push('Negative quantity');
        }

        // Timestamp
        const ts = timestampRaw === undefined ? null : new Date(String(timestampRaw).trim());
        const timestamp = ts && !Number.isNaN(ts.getTime()) ? ts : null;
        if (!timestamp) {
          isValid = false;
          reasons.push('Invalid timestamp');
        }

        // Minimal fields required for matching.
        if (!type) {
          isValid = false;
          reasons.push('Missing type');
        }
        if (!asset) {
          isValid = false;
          reasons.push('Missing asset');
        }

        // Persist the row regardless of validity, with explicit error reasons.
        results.push({
          runId,
          source, // 'user' | 'exchange'
          externalId,
          timestamp,
          type,
          asset,
          quantity,
          isValid,
          errorReason: reasons.length ? reasons.join('; ') : null,
        });
      })
      .on('end', async () => {
        try {
          // Bulk insert for efficiency; keep going on per-document errors.
          await Transaction.insertMany(results, { ordered: false });
          resolve(results.length);
        } catch (error) {
          reject(error);
        }
      })
      .on('error', (error) => reject(error));
  });
};

module.exports = { processCSV };