import express from 'express';
import multer from 'multer';
import { supabase } from '../db.js';
import { listSavedLabels, orgSearch, mapApolloOrgToLead } from '../services/apollo.js';
import { extractApolloFilters } from '../services/claude.js';
import { parseCsvBuffer, mapRowsToLeads, getMappedColumns } from '../services/csv.js';

export const sourcesRouter = express.Router();

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

sourcesRouter.get('/apollo-labels', wrap(async (_req, res) => {
  const labels = await listSavedLabels();
  res.json({ labels });
}));

sourcesRouter.post('/apollo-filters/preview', wrap(async (req, res) => {
  const { prompt } = req.body || {};
  if (!prompt) return res.status(400).json({ error: 'prompt required' });
  const filters = await extractApolloFilters(prompt);
  res.json({ filters });
}));

sourcesRouter.post('/apollo-search/preview', wrap(async (req, res) => {
  const { filters, per_page = 25 } = req.body || {};
  if (!filters) return res.status(400).json({ error: 'filters required' });
  const orgs = await orgSearch(filters, { maxPages: 1, perPage: Math.min(100, per_page) });
  const sample = orgs.slice(0, per_page).map(mapApolloOrgToLead).filter(Boolean);
  res.json({ total_sampled: orgs.length, sample });
}));

sourcesRouter.post('/csv/preview', upload.single('file'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file required (multipart field: file)' });
  let parsed;
  try {
    parsed = parseCsvBuffer(req.file.buffer);
  } catch (e) {
    return res.status(400).json({ error: `CSV parse failed: ${e.message}` });
  }
  const columnMap = getMappedColumns(parsed.headers);
  const mapped = mapRowsToLeads(parsed.rows, parsed.headers);
  const { data, error } = await supabase
    .from('csv_uploads')
    .insert({
      rows: parsed.rows,
      headers: parsed.headers,
      column_map: columnMap,
      filename: req.file.originalname,
    })
    .select('id')
    .single();
  if (error) return res.status(500).json({ error: `Stage failed: ${error.message}` });
  res.json({
    staging_id: data.id,
    filename: req.file.originalname,
    headers: parsed.headers,
    mapped_columns: columnMap,
    sample_rows: parsed.rows.slice(0, 10),
    total_rows: parsed.rows.length,
    deduped_leads: mapped.length,
  });
}));
