const Transaction = require('../models/Transaction');

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
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
  // Keep columns stable and explicit (easy to review + parse).
  return [
    category,
    reason || '',

    // User side (where applicable)
    userTx?.externalId || '',
    asIso(userTx?.timestamp),
    userTx?.type || '',
    userTx?.asset || '',
    userTx?.quantity ?? '',
    userTx?.rawRow ? JSON.stringify(userTx.rawRow) : '',

    // Exchange side (where applicable)
    exchangeTx?.externalId || '',
    asIso(exchangeTx?.timestamp),
    exchangeTx?.type || '',
    exchangeTx?.asset || '',
    exchangeTx?.quantity ?? '',
    exchangeTx?.rawRow ? JSON.stringify(exchangeTx.rawRow) : '',
  ].map(csvEscape).join(',');
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
    'user_rawRow_json',
    'exchange_externalId',
    'exchange_timestamp',
    'exchange_type',
    'exchange_asset',
    'exchange_quantity',
    'exchange_rawRow_json',
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

  return lines.join('\n');
}

module.exports = { generateReportCsv };

