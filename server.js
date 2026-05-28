require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');

const { generateReportCsv } = require('./services/reportService');
const { reconcileRun } = require('./services/reconcileService');

const uri = process.env.MONGO_URI;
const PORT = Number.parseInt(process.env.PORT || '3000', 10);

if (!uri) {
  // Fail fast to make misconfiguration obvious during review.
  throw new Error('Missing required env var: MONGO_URI');
}

async function start() {
  await mongoose.connect(uri);
  console.log('✅ Connected to MongoDB');
  console.log(`Database: ${mongoose.connection.name}`);

  const app = express();
  app.use(express.json());

  // Task 4 (minimal): triggers ingestion for both CSV sources under a single runId.
  app.post('/reconcile', async (req, res) => {
    try {
      // Optional: allow custom CSV paths for testing, while defaulting to /data/*.csv.
      const {
        userCsvPath,
        exchangeCsvPath,
        timestampToleranceSeconds,
        quantityTolerancePct,
      } = req.body || {};

      const result = await reconcileRun({
        userCsvPath,
        exchangeCsvPath,
        timestampToleranceSeconds,
        quantityTolerancePct,
      });
      res.status(201).json(result);
    } catch (err) {
      res.status(500).json({ error: err?.message || 'Unknown error' });
    }
  });

  app.get('/health', (req, res) => {
    res.json({ ok: true });
  });

  // Task 3: generate reconciliation report (CSV) for a run.
  app.get('/report/:runId', async (req, res) => {
    try {
      const { runId } = req.params;
      const csv = await generateReportCsv(runId);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="reconciliation-report-${runId}.csv"`);
      res.status(200).send(csv);
    } catch (err) {
      res.status(500).json({ error: err?.message || 'Unknown error' });
    }
  });

  app.listen(PORT, () => {
    console.log(`🚀 API listening on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error('❌ Startup error:', err?.message || err);
  process.exitCode = 1;
});


app.get('/report/:runId/summary', async (req, res) => {});
app.get('/report/:runId/unmatched', async (req, res) => {});
