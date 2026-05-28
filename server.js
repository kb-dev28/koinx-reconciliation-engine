require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');

const logger = require('./logger');
const {
  reconcileRun,
  generateReportCsv,
  getReportSummary,
  getUnmatchedRows,
  ensureOutputsDir,
} = require('./services/reconcileService');

const uri = process.env.MONGO_URI;
const PORT = Number.parseInt(process.env.PORT || '3000', 10);

if (!uri) {
  throw new Error('Missing required env var: MONGO_URI');
}

async function start() {
  await mongoose.connect(uri);
  logger.info('Connected to MongoDB', { database: mongoose.connection.name });

  const app = express();
  app.use(express.json());

  app.get('/health', (req, res) => {
    res.json({ ok: true });
  });

  // POST /reconcile — ingestion + matching (optional tolerance overrides in body)
  app.post('/reconcile', async (req, res) => {
    try {
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

      logger.info('POST /reconcile completed', { runId: result.runId, summary: result.matching?.summary });
      res.status(201).json(result);
    } catch (err) {
      logger.error('POST /reconcile failed', { message: err?.message });
      res.status(500).json({ error: err?.message || 'Unknown error' });
    }
  });

  // GET /report/:runId — full reconciliation report (CSV)
  app.get('/report/:runId', async (req, res) => {
    try {
      const { runId } = req.params;
      const { csv, outputPath } = await generateReportCsv(runId);
      logger.info('GET /report/:runId completed', { runId, outputPath });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="reconciliation-report-${runId}.csv"`,
      );
      res.status(200).send(csv);
    } catch (err) {
      res.status(500).json({ error: err?.message || 'Unknown error' });
    }
  });

  // GET /report/:runId/summary — counts only
  app.get('/report/:runId/summary', async (req, res) => {
    try {
      const { runId } = req.params;
      const summary = await getReportSummary(runId);
      res.status(200).json(summary);
    } catch (err) {
      res.status(500).json({ error: err?.message || 'Unknown error' });
    }
  });

  // GET /report/:runId/unmatched — unmatched rows with reasons
  app.get('/report/:runId/unmatched', async (req, res) => {
    try {
      const { runId } = req.params;
      const unmatched = await getUnmatchedRows(runId);
      res.status(200).json(unmatched);
    } catch (err) {
      res.status(500).json({ error: err?.message || 'Unknown error' });
    }
  });

  ensureOutputsDir();

  app.listen(PORT, () => {
    logger.info('API listening', {
      url: `http://localhost:${PORT}`,
      endpoints: [
        'POST /reconcile',
        'GET /report/:runId',
        'GET /report/:runId/summary',
        'GET /report/:runId/unmatched',
        'GET /health',
      ],
    });
  });
}

start().catch((err) => {
  logger.error('Startup failed', { message: err?.message || String(err) });
  process.exitCode = 1;
});
