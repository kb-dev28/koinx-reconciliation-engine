/**
 * Lightweight structured logger (no external deps).
 * Format: [ISO_TIMESTAMP] [LEVEL] message {optional_json_meta}
 */

function formatMeta(meta) {
  if (meta === undefined || meta === null) return '';
  try {
    return ` ${JSON.stringify(meta)}`;
  } catch {
    return ' [meta_unserializable]';
  }
}

function log(level, message, meta) {
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}${formatMeta(meta)}`;
  if (level === 'error') console.error(line);
  else console.log(line);
}

module.exports = {
  info: (message, meta) => log('info', message, meta),
  warn: (message, meta) => log('warn', message, meta),
  error: (message, meta) => log('error', message, meta),
};
