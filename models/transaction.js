const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  // Groups all transactions from a single reconciliation run.
  // Supports /report/:runId without mixing datasets across runs.
  runId: { type: String, required: true, index: true, trim: true },

  // 'user' = user-side CSV, 'exchange' = exchange-side CSV.
  source: { type: String, enum: ['user', 'exchange'], required: true, index: true },

  // Raw ID from the CSV. Not globally unique — may be absent or collide across sources/runs.
  externalId: { type: String, default: null, trim: true },

  // Parsed at ingestion time and stored as Date.
  timestamp: { type: Date, default: null, index: true },

  // Stored as-is to tolerate messy data; mapping is handled by the matching engine.
  type: { type: String, default: null, trim: true, uppercase: true, index: true },

  // Normalised for case-insensitive matching and alias resolution (e.g. BTC, ETH, USDT).
  asset: { type: String, default: null, trim: true, uppercase: true, index: true },

  // NOTE: Decimal128 is preferable in production to avoid floating-point drift.
  quantity: { type: Number, default: null },

  // Invalid rows are flagged and kept for audit — never dropped.
  isValid: { type: Boolean, default: true, index: true },
  errorReason: { type: String, default: null, trim: true },

  reconciliationStatus: {
    type: String,
    enum: ['pending', 'matched', 'conflicting', 'unmatched'],
    default: 'pending',
    index: true,
  },

  // Reference to the matched counterpart; used for reports and match debugging.
  matchedWith: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', default: null, index: true },

  // Human-readable explanation of the reconciliation outcome (e.g. "tolerance exceeded").
  reconciliationReason: { type: String, default: null, trim: true },

}, { timestamps: true, minimize: false });

// Compound indexes for typical report queries filtered by run, source, and status.
transactionSchema.index({ runId: 1, source: 1 });
transactionSchema.index({ runId: 1, reconciliationStatus: 1, source: 1 });

module.exports = mongoose.model('Transaction', transactionSchema);