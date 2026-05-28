const fs = require('fs');
const csv = require('csv-parser');
const Transaction = require('../models/transaction');
const logger = require('../logger');
const csvHeaderAliases = require('../config/csvHeaderAliases.json');
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

function pickCanonicalField(row, canonicalKey) {
  const candidates = csvHeaderAliases?.[canonicalKey];
  if (!Array.isArray(candidates) || candidates.length === 0) return undefined;
  return pickField(row, candidates);
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
  const mapped = assetAliases[upper];
  if (mapped) return String(mapped).trim().toUpperCase();
  return upper;
}

function normaliseType(raw) {
  const type = normaliseString(raw);
  return type ? type.toUpperCase() : null;
}

const processCSV = async (filePath, source, runId) => {
  // Track externalIds already stored for this run + source (MongoDB + current batch).
  const existingRows = await Transaction.find({
    runId,
    source,
    externalId: { $ne: null },
  })
    .select('externalId')
    .lean();

  const seenExternalIds = new Set(
    existingRows.map((row) => row.externalId).filter(Boolean),
  );

  const results = [];

  return new Promise((resolve, reject) => {
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (data) => {
        // Ingestion: normalize + validate per-row (do not drop invalid rows).
        let isValid = true;
        const reasons = [];

        // Resolve source header variations via config-driven aliases.
        const externalIdRaw = pickCanonicalField(data, 'externalId');
        const timestampRaw = pickCanonicalField(data, 'timestamp');
        const typeRaw = pickCanonicalField(data, 'type');
        const assetRaw = pickCanonicalField(data, 'asset');
        const quantityRaw = pickCanonicalField(data, 'quantity');

        const externalId = normaliseString(externalIdRaw);
        const type = normaliseType(typeRaw);
        const asset = normaliseAsset(assetRaw);

        // Quantity
        const quantityParsed = quantityRaw === undefined ? NaN : Number.parseFloat(String(quantityRaw).trim());
        const quantity = Number.isFinite(quantityParsed) ? quantityParsed : null;
        if (quantity === null) {
          isValid = false;
          reasons.push('Invalid quantity');
        } else if (quantity <= 0) {
          isValid = false;
          reasons.push('Quantity must be greater than zero');
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

        // Duplicate detection: same externalId + source within the same runId.
        if (externalId) {
          if (seenExternalIds.has(externalId)) {
            isValid = false;
            reasons.push('Duplicate externalId');
          } else {
            seenExternalIds.add(externalId);
          }
        }

        // Persist the row regardless of validity, with explicit error reasons.
        results.push({
          runId,
          source, // 'user' | 'exchange'
          externalId,
          rawRow: data,
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
          const invalidCount = results.reduce((acc, row) => acc + (row.isValid ? 0 : 1), 0);
          const duplicateCount = results.filter((row) =>
            row.errorReason?.includes('Duplicate externalId'),
          ).length;
          const stats = {
            totalRows: results.length,
            invalidRows: invalidCount,
            validRows: results.length - invalidCount,
            duplicateRows: duplicateCount,
          };
          logger.info('CSV ingestion finished', { runId, source, filePath, ...stats });
          resolve(stats);
        } catch (error) {
          reject(error);
        }
      })
      .on('error', (error) => reject(error));
  });
};

module.exports = { processCSV };