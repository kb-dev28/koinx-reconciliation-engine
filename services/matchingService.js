const Transaction = require('../models/Transaction');
const assetAliases = require('../config/assetAliases.json');

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Reads a numeric env var; falls back if missing/invalid.
const getEnvNumber = (name, fallback) => {
  const n = Number.parseFloat(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
};

// Basic string normalisation: String(...) + trim; returns null if empty.
const normaliseString = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
};

// Asset normalisation for case-insensitive matching + alias resolution (config-driven).
const normaliseAsset = (raw) => {
  const s = normaliseString(raw);
  if (!s) return null;
  const upper = s.toUpperCase();
  const alias = assetAliases[upper];
  // Alias resolution is config-driven to support new datasets without code changes.
  return alias ? String(alias).trim().toUpperCase() : upper;
};

// Type normalisation (BUY/SELL/TRANSFER_*) to uppercase for consistent comparisons.
const normaliseType = (raw) => {
  const s = normaliseString(raw);
  return s ? s.toUpperCase() : null;
};

// Type compatibility:
// - exact match, OR
// - required mapping: TRANSFER_OUT (user) ↔ TRANSFER_IN (exchange)
const isTypeCompatible = (u, e) => {
  if (!u || !e) return false;
  if (u === e) return true;
  // Same transfer event seen from opposite sides.
  return (u === 'TRANSFER_OUT' && e === 'TRANSFER_IN') ||
         (u === 'TRANSFER_IN'  && e === 'TRANSFER_OUT');
};

// Timestamp window: accept if absolute difference is within ±toleranceSec.
const withinTimestampTolerance = (uTs, eTs, toleranceSec) => {
  if (!uTs || !eTs) return false;
  return Math.abs(new Date(uTs) - new Date(eTs)) <= toleranceSec * 1000;
};

// Quantity tolerance (percentage): diff <= max(|u|,|e|,1) * (tolerancePct/100)
const withinQuantityTolerance = (uQty, eQty, tolerancePct) => {
  if (uQty == null || eQty == null) return false;
  if (!Number.isFinite(uQty) || !Number.isFinite(eQty)) return false;
  const diff = Math.abs(uQty - eQty);
  const scale = Math.max(Math.abs(uQty), Math.abs(eQty), 1); // avoid division by zero
  return diff <= scale * (tolerancePct / 100);
};

// Lower score = better candidate (time closeness first, then quantity).
const scoreCandidate = (uTs, uQty, eTs, eQty) =>
  Math.abs(uTs - new Date(eTs)) * 1_000_000 + Math.abs(uQty - eQty);

// ─── Core ─────────────────────────────────────────────────────────────────────

async function matchRun({
  runId,
  timestampToleranceSeconds = getEnvNumber('TIMESTAMP_TOLERANCE_SECONDS', 300),
  quantityTolerancePct     = getEnvNumber('QUANTITY_TOLERANCE_PCT', 0.01),
} = {}) {
  if (!runId) throw new Error('matchRun: runId is required');

  // Load valid rows for the run. Ingestion is expected to have normalised asset/type already.
  const txs = await Transaction.find({
    runId,
    isValid: true,
    timestamp: { $ne: null },
    type:      { $ne: null },
    asset:     { $ne: null },
    quantity:  { $ne: null },
  }).select('_id source timestamp type asset quantity').lean();

  // Split by source (user vs exchange).
  const bySource = { user: [], exchange: [] };
  for (const tx of txs) bySource[tx.source]?.push(tx);

  // Sort by timestamp for more deterministic matching.
  const sortByTime = (arr) => arr.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  sortByTime(bySource.user);
  sortByTime(bySource.exchange);

  // Prevent an exchange transaction from matching multiple user transactions.
  const usedExchangeIds = new Set();
  const updates = [];
  const summary = { matched: 0, conflicting: 0, unmatchedUser: 0, unmatchedExchange: 0 };

  // Helper to prepare Mongo updates (applied at the end via bulkWrite).
  const setStatus = (id, status, matchedWith, reason) => ({
    updateOne: {
      filter: { _id: id },
      update: { $set: { reconciliationStatus: status, matchedWith, reconciliationReason: reason } },
    },
  });

  // For each user transaction, find the best exchange candidate within tolerances.
  for (const u of bySource.user) {
    const uTs  = new Date(u.timestamp);
    const uQty = Number(u.quantity);

    let bestMatch    = null, bestMatchScore    = Infinity;
    let bestConflict = null, bestConflictScore = Infinity;

    for (const e of bySource.exchange) {
      if (usedExchangeIds.has(String(e._id))) continue;
      if (u.asset !== e.asset) continue;
      if (!isTypeCompatible(u.type, e.type)) continue;
      if (!withinTimestampTolerance(uTs, e.timestamp, timestampToleranceSeconds)) continue;

      const eQty = Number(e.quantity);
      const s    = scoreCandidate(uTs, uQty, e.timestamp, eQty);

      if (withinQuantityTolerance(uQty, eQty, quantityTolerancePct)) {
        if (s < bestMatchScore)    { bestMatch    = e; bestMatchScore    = s; }
      } else {
        // Close in time/asset/type but quantity out of tolerance → conflicting.
        if (s < bestConflictScore) { bestConflict = e; bestConflictScore = s; }
      }
    }

    if (bestMatch) {
      // Matched: update both docs with mutual references.
      usedExchangeIds.add(String(bestMatch._id));
      summary.matched++;
      updates.push(
        setStatus(u._id,         'matched', bestMatch._id, null),
        setStatus(bestMatch._id, 'matched', u._id,         null),
      );
    } else if (bestConflict) {
      // Conflicting: close candidate found (time/type/asset) but quantity out of tolerance.
      usedExchangeIds.add(String(bestConflict._id));
      summary.conflicting++;
      const reason = `Quantity difference exceeds tolerance (${quantityTolerancePct}%)`;
      updates.push(
        setStatus(u._id,            'conflicting', bestConflict._id, reason),
        setStatus(bestConflict._id, 'conflicting', u._id,            reason),
      );
    } else {
      // Unmatched (user only): no compatible candidate found.
      summary.unmatchedUser++;
      updates.push(setStatus(u._id, 'unmatched', null, 'No candidate found within tolerance window'));
    }
  }

  // Remaining exchange rows become unmatched (exchange only).
  for (const e of bySource.exchange) {
    if (usedExchangeIds.has(String(e._id))) continue;
    summary.unmatchedExchange++;
    updates.push(setStatus(e._id, 'unmatched', null, 'No counterpart found in user dataset'));
  }

  // Persist status updates in bulk for efficiency.
  if (updates.length) await Transaction.bulkWrite(updates, { ordered: false });

  // Return effective config + summary counts.
  return { runId, config: { timestampToleranceSeconds, quantityTolerancePct }, summary };
}

module.exports = { matchRun, normaliseString, normaliseAsset, normaliseType };