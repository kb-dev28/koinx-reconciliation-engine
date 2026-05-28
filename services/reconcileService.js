const path = require('path');
const crypto = require('crypto');

const Transaction = require('../models/Transaction');
const logger = require('../logger');
const { processCSV } = require('./ingestionService');
const { matchRun } = require('./matchingService');

function createRunId() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
}

/**
 * Part 3 (Reconciliation Orchestration):
 * Runs ingestion (Part 1) + matching (Part 2) under a single runId.
 */
async function reconcileRun({
  runId = createRunId(),
  userCsvPath = path.join(process.cwd(), 'data', 'user_transactions.csv'),
  exchangeCsvPath = path.join(process.cwd(), 'data', 'exchange_transactions.csv'),
  timestampToleranceSeconds,
  quantityTolerancePct,
} = {}) {
  logger.info('Reconciliation run started', { runId, userCsvPath, exchangeCsvPath });

  const [user, exchange] = await Promise.all([
    processCSV(userCsvPath, 'user', runId),
    processCSV(exchangeCsvPath, 'exchange', runId),
  ]);

  logger.info('Ingestion completed', { runId, user, exchange });

  const matching = await matchRun({ runId, timestampToleranceSeconds, quantityTolerancePct });

  logger.info('Matching completed', { runId, summary: matching.summary });

  return {
    runId,
    ingestion: { user, exchange },
    matching,
  };
}

/** RFC 4180-style escaping; always quote JSON payloads for Excel compatibility. */
function csvEscape(value, { forceQuote = false } = {}) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  const mustQuote = forceQuote || /[",\n\r]/.test(s);
  if (!mustQuote) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

function toOriginalRowJson(rawRow) {
  if (!rawRow) return '';
  return JSON.stringify(rawRow);
}

function asIso(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString();
}

function getCategory(tx, source) {
  // source is the perspective for unmatched labels
  if (tx.reconciliationStatus === 'matched') return 'Matched';
  if (tx.reconciliationStatus === 'conflicting') return 'Conflicting';
  if (tx.reconciliationStatus === 'unmatched') {
    return source === 'user' ? 'Unmatched (User only)' : 'Unmatched (Exchange only)';
  }
  return 'Unmatched';
}

function buildRow({ category, reason, userTx, exchangeTx }) {
  const cells = [
    category,
    reason || '',
    userTx?.externalId || '',
    asIso(userTx?.timestamp),
    userTx?.type || '',
    userTx?.asset || '',
    userTx?.quantity ?? '',
    toOriginalRowJson(userTx?.rawRow),
    exchangeTx?.externalId || '',
    asIso(exchangeTx?.timestamp),
    exchangeTx?.type || '',
    exchangeTx?.asset || '',
    exchangeTx?.quantity ?? '',
    toOriginalRowJson(exchangeTx?.rawRow),
  ];

  return cells
    .map((cell, idx) => {
      const isJsonCol = idx === 7 || idx === 13;
      return csvEscape(cell, { forceQuote: isJsonCol || /[",\n\r]/.test(String(cell)) });
    })
    .join(',');
}

async function generateReportCsv(runId) {
  if (!runId) throw new Error('generateReportCsv: runId is required');

  const txs = await Transaction.find({ runId })
    .select('_id source externalId rawRow timestamp type asset quantity isValid errorReason reconciliationStatus matchedWith reconciliationReason')
    .lean();

  const byId = new Map(txs.map((t) => [String(t._id), t]));
  const matchedIds = new Set();

  const header = [
    'category',
    'reason',
    'user_externalId',
    'user_timestamp',
    'user_type',
    'user_asset',
    'user_quantity',
    'user_original_row_json',
    'exchange_externalId',
    'exchange_timestamp',
    'exchange_type',
    'exchange_asset',
    'exchange_quantity',
    'exchange_original_row_json',
  ].join(',');

  const lines = [header];

  // 1) Emit paired rows based on user side, if matchedWith exists.
  for (const u of txs.filter((t) => t.source === 'user')) {
    const category = getCategory(u, 'user');

    // Ingestion invalid rows are still part of the report.
    if (!u.isValid) {
      lines.push(buildRow({
        category: 'Unmatched (User only)',
        reason: u.errorReason || 'Invalid row (ingestion)',
        userTx: u,
        exchangeTx: null,
      }));
      continue;
    }

    const pairId = u.matchedWith ? String(u.matchedWith) : null;
    const e = pairId ? byId.get(pairId) : null;

    if (e && e.source === 'exchange') {
      matchedIds.add(String(u._id));
      matchedIds.add(String(e._id));
      const reason = u.reconciliationReason || e.reconciliationReason || '';
      lines.push(buildRow({ category, reason, userTx: u, exchangeTx: e }));
    } else if (u.reconciliationStatus === 'unmatched') {
      lines.push(buildRow({
        category,
        reason: u.reconciliationReason || 'No counterpart found',
        userTx: u,
        exchangeTx: null,
      }));
    } else if (u.reconciliationStatus === 'pending') {
      lines.push(buildRow({
        category: 'Unmatched (User only)',
        reason: 'Pending matching (not processed)',
        userTx: u,
        exchangeTx: null,
      }));
    } else {
      // Fallback for any unexpected state
      lines.push(buildRow({
        category: 'Unmatched (User only)',
        reason: u.reconciliationReason || 'No counterpart found',
        userTx: u,
        exchangeTx: null,
      }));
    }
  }

  // 2) Emit remaining exchange-only rows (unmatched + invalid).
  for (const e of txs.filter((t) => t.source === 'exchange')) {
    if (matchedIds.has(String(e._id))) continue;

    if (!e.isValid) {
      lines.push(buildRow({
        category: 'Unmatched (Exchange only)',
        reason: e.errorReason || 'Invalid row (ingestion)',
        userTx: null,
        exchangeTx: e,
      }));
      continue;
    }

    const category = getCategory(e, 'exchange');
    const reason = e.reconciliationReason || (category.startsWith('Unmatched') ? 'No counterpart found' : '');
    lines.push(buildRow({ category, reason, userTx: null, exchangeTx: e }));
  }

  // UTF-8 BOM helps Excel open accents/JSON reliably on Windows.
  return `\uFEFF${lines.join('\r\n')}`;
}

async function getReportSummary(runId) {
  if (!runId) throw new Error('getReportSummary: runId is required');

  const rows = await Transaction.find({ runId, isValid: true })
    .select('source reconciliationStatus')
    .lean();

  const summary = {
    matched: 0,
    conflicting: 0,
    unmatchedUser: 0,
    unmatchedExchange: 0,
  };

  // Count pairs from the user side to align with matching.summary (not 2x documents).
  for (const tx of rows) {
    if (tx.source === 'user') {
      if (tx.reconciliationStatus === 'matched') summary.matched += 1;
      else if (tx.reconciliationStatus === 'conflicting') summary.conflicting += 1;
      else if (tx.reconciliationStatus === 'unmatched') summary.unmatchedUser += 1;
    } else if (tx.source === 'exchange' && tx.reconciliationStatus === 'unmatched') {
      summary.unmatchedExchange += 1;
    }
  }

  return { runId, summary };
}

async function getUnmatchedRows(runId) {
  if (!runId) throw new Error('getUnmatchedRows: runId is required');

  const rows = await Transaction.find({
    runId,
    reconciliationStatus: 'unmatched',
  })
    .select('source externalId timestamp type asset quantity isValid errorReason reconciliationReason rawRow')
    .lean();

  return {
    runId,
    count: rows.length,
    rows: rows.map((tx) => ({
      source: tx.source,
      externalId: tx.externalId,
      timestamp: tx.timestamp,
      type: tx.type,
      asset: tx.asset,
      quantity: tx.quantity,
      isValid: tx.isValid,
      ingestionError: tx.errorReason,
      reason: tx.reconciliationReason || tx.errorReason || 'Unmatched',
      rawRow: tx.rawRow,
    })),
  };
}

module.exports = {
  reconcileRun,
  generateReportCsv,
  getReportSummary,
  getUnmatchedRows,
};

