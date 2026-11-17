import AdmZip from 'adm-zip';
import Database from 'better-sqlite3';
import express, { type Request, type Response } from 'express';
import fs from 'fs';
import http from 'http';
import multer from 'multer';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import {
  closeDb,
  copyProductImageToQuoteSnapshot,
  DATA_DIR,
  DB_PATH,
  ensureDataDirs,
  getDb,
  getNextQuoteNumber,
  getSetting,
  IMAGES_DIR,
  type IssuedQuoteItemRow,
  type IssuedQuoteRow,
  type MetalColorRow,
  type MetalProductRow,
  PRODUCT_IMAGES_DIR,
  QUOTE_IMAGES_DIR,
  reloadDb,
  removeImageFileIfUnused,
  resolveSafeImagePath,
  seedInitialDataIfEmpty,
  setSetting,
} from './server/db.ts';
import {
  buildColorsExcel,
  buildColorsPdf,
  buildIssuedQuotesExcel,
  buildIssuedQuotesPdf,
  buildProductsExcel,
  buildProductsPdf,
  buildSingleQuoteExcel,
  buildSingleQuotePdf,
  type ExportQuotePayload,
} from './server/exports.ts';

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const HEX_REGEX = /^#[0-9A-Fa-f]{6}$/;

const uploadMemory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

function normalizeHex(raw: string): string | null {
  const trimmed = raw.trim();
  const withHash = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
  if (!HEX_REGEX.test(withHash)) return null;
  return withHash.toUpperCase();
}

function parseCents(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) {
    return raw;
  }
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) {
      return Math.round(n);
    }
  }
  return null;
}

function queryIssuedQuotes(query: Request['query']): IssuedQuoteRow[] {
  const db = getDb();
  const search = typeof query.search === 'string' ? query.search.trim() : '';
  const dateFrom = typeof query.dateFrom === 'string' ? query.dateFrom.trim() : '';
  const dateTo = typeof query.dateTo === 'string' ? query.dateTo.trim() : '';
  const sortByRaw = typeof query.sortBy === 'string' ? query.sortBy : 'created_at';
  const sortDirRaw = typeof query.sortDir === 'string' ? query.sortDir.toUpperCase() : 'DESC';

  const sortColMap: Record<string, string> = {
    quote_number: 'quote_number',
    quote_date: 'quote_date',
    customer_name: 'COALESCE(customer_name, \'\')',
    total_cents: 'total_cents',
    created_at: 'created_at',
  };
  const orderCol = sortColMap[sortByRaw] ?? 'created_at';
  const orderDir = sortDirRaw === 'ASC' ? 'ASC' : 'DESC';

  const where: string[] = [];
  const params: unknown[] = [];

  if (search) {
    where.push('(quote_number LIKE ? OR COALESCE(customer_name, \'\') LIKE ?)');
    params.push(`%${search}%`, `%${search}%`);
  }
  if (dateFrom) {
    where.push('quote_date >= ?');
    params.push(dateFrom);
  }
  if (dateTo) {
    where.push('quote_date <= ?');
    params.push(dateTo);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  return db
    .prepare(`SELECT * FROM issued_quotes ${whereClause} ORDER BY ${orderCol} ${orderDir}, id DESC`)
    .all(...params) as IssuedQuoteRow[];
}

async function processProductImage(buffer: Buffer): Promise<string> {
  ensureDataDirs();
  const filename = `prod-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
  const outPath = path.join(PRODUCT_IMAGES_DIR, filename);
  await sharp(buffer)
    .rotate()
    .resize(128, 128, {
      fit: 'contain',
      background: { r: 247, g: 247, b: 247, alpha: 1 },
    })
    .png({ compressionLevel: 9 })
    .toFile(outPath);
  return `products/${filename}`;
}

async function buildDraftPayloadForExport(body: {
  quote_date?: string;
  customer_name?: string;
  items?: Array<{
    product_id?: number | null;
    color_id?: number | null;
    linear_feet?: number;
    additional_costs_cents?: number | string | null;
    additional_costs_description?: string | null;
  }>;
}): Promise<ExportQuotePayload> {
  const db = getDb();
  const quoteDate =
    typeof body.quote_date === 'string' && body.quote_date.trim()
      ? body.quote_date.trim()
      : new Date().toISOString().slice(0, 10);
  const customerName =
    typeof body.customer_name === 'string' && body.customer_name.trim()
      ? body.customer_name.trim()
      : null;

  const rawItems = Array.isArray(body.items) ? body.items : [];
  if (rawItems.length === 0) {
    throw new Error('Add at least one complete product line before exporting.');
  }

  const getProd = db.prepare('SELECT * FROM metal_products WHERE id = ?');
  const getColor = db.prepare('SELECT * FROM metal_colors WHERE id = ?');

  const resolvedItems: ExportQuotePayload['items'] = [];
  let totalCents = 0;

  for (const item of rawItems) {
    if (!item.product_id || !item.color_id) {
      throw new Error('Every quote line must have both a product and a color selected.');
    }
    const lf = Number(item.linear_feet);
    if (!Number.isFinite(lf) || lf <= 0) {
      throw new Error('Every quote line must have Linear Feet greater than 0.');
    }

    let additionalCostsCents = 0;
    if (
      item.additional_costs_cents !== undefined &&
      item.additional_costs_cents !== null &&
      item.additional_costs_cents !== ''
    ) {
      const parsedAdd = parseCents(item.additional_costs_cents);
      if (parsedAdd === null) {
        throw new Error('Additional Costs must be a valid non-negative amount.');
      }
      additionalCostsCents = parsedAdd;
    }

    const additionalCostsDescription =
      typeof item.additional_costs_description === 'string' &&
      item.additional_costs_description.trim()
        ? item.additional_costs_description.trim().slice(0, 200)
        : null;

    const product = getProd.get(item.product_id) as MetalProductRow | undefined;
    const color = getColor.get(item.color_id) as MetalColorRow | undefined;
    if (!product || !color) {
      throw new Error('One or more selected products or colors no longer exist.');
    }

    const combined = product.price_per_lf_cents + color.price_per_lf_cents;
    const lineTotal = Math.round(lf * combined) + additionalCostsCents;
    totalCents += lineTotal;

    resolvedItems.push({
      product_name: product.name,
      product_image_path: product.image_path,
      color_name: color.name,
      color_hex: color.hex_code,
      product_price_per_lf_cents: product.price_per_lf_cents,
      color_price_per_lf_cents: color.price_per_lf_cents,
      combined_price_per_lf_cents: combined,
      linear_feet: lf,
      additional_costs_cents: additionalCostsCents,
      additional_costs_description: additionalCostsDescription,
      line_total_cents: lineTotal,
    });
  }

  return {
    quote_number: 'DRAFT',
    quote_date: quoteDate,
    customer_name: customerName,
    total_cents: totalCents,
    items: resolvedItems,
  };
}

async function startServer() {
  ensureDataDirs();
  getDb();
  await seedInitialDataIfEmpty();

  const app = express();
  app.use(express.json({ limit: '5mb' }));

  // Serve stored product & quote snapshot images safely
  app.get('/api/images/:folder/:filename', (req: Request, res: Response) => {
    const { folder, filename } = req.params;
    if (folder !== 'products' && folder !== 'quotes') {
      res.status(404).end();
      return;
    }
    if (!/^[a-zA-Z0-9._-]+$/.test(filename)) {
      res.status(400).end();
      return;
    }
    const fullPath = resolveSafeImagePath(`${folder}/${filename}`);
    if (!fullPath) {
      res.status(404).end();
      return;
    }
    res.sendFile(fullPath);
  });

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  // ============================================================================
  // METAL COLORS
  // ============================================================================
  app.get('/api/colors', (_req: Request, res: Response) => {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM metal_colors ORDER BY id ASC').all() as MetalColorRow[];
    res.json(rows);
  });

  app.post('/api/colors', (req: Request, res: Response) => {
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const hex = typeof req.body.hex_code === 'string' ? normalizeHex(req.body.hex_code) : null;
    const priceCents = parseCents(req.body.price_per_lf_cents);

    if (!name) {
      res.status(400).json({ error: 'Color name is required.' });
      return;
    }
    if (!hex) {
      res.status(400).json({ error: 'Valid 6-digit HEX code (e.g. #084091) is required.' });
      return;
    }
    if (priceCents === null) {
      res.status(400).json({ error: 'Valid non-negative price per linear ft is required.' });
      return;
    }

    const db = getDb();
    const now = new Date().toISOString();
    const info = db
      .prepare(
        'INSERT INTO metal_colors (name, hex_code, price_per_lf_cents, is_available, created_at) VALUES (?, ?, ?, 1, ?)'
      )
      .run(name, hex, priceCents, now);
    const created = db.prepare('SELECT * FROM metal_colors WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json(created);
  });

  app.put('/api/colors/:id', (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const hex = typeof req.body.hex_code === 'string' ? normalizeHex(req.body.hex_code) : null;
    const priceCents = parseCents(req.body.price_per_lf_cents);

    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'Invalid color ID.' });
      return;
    }
    if (!name) {
      res.status(400).json({ error: 'Color name is required.' });
      return;
    }
    if (!hex) {
      res.status(400).json({ error: 'Valid 6-digit HEX code is required.' });
      return;
    }
    if (priceCents === null) {
      res.status(400).json({ error: 'Valid price per linear ft is required.' });
      return;
    }

    const db = getDb();
    const existing = db.prepare('SELECT * FROM metal_colors WHERE id = ?').get(id);
    if (!existing) {
      res.status(404).json({ error: 'Color not found.' });
      return;
    }

    db.prepare('UPDATE metal_colors SET name = ?, hex_code = ?, price_per_lf_cents = ? WHERE id = ?').run(
      name,
      hex,
      priceCents,
      id
    );
    const updated = db.prepare('SELECT * FROM metal_colors WHERE id = ?').get(id);
    res.json(updated);
  });

  app.patch('/api/colors/:id/availability', (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const isAvailable = req.body.is_available ? 1 : 0;
    const db = getDb();
    const existing = db.prepare('SELECT * FROM metal_colors WHERE id = ?').get(id);
    if (!existing) {
      res.status(404).json({ error: 'Color not found.' });
      return;
    }
    db.prepare('UPDATE metal_colors SET is_available = ? WHERE id = ?').run(isAvailable, id);
    res.json(db.prepare('SELECT * FROM metal_colors WHERE id = ?').get(id));
  });

  app.delete('/api/colors/:id', (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const db = getDb();
    const info = db.prepare('DELETE FROM metal_colors WHERE id = ?').run(id);
    if (info.changes === 0) {
      res.status(404).json({ error: 'Color not found.' });
      return;
    }
    res.json({ deleted: true });
  });

  app.get('/api/colors/export/excel', async (_req: Request, res: Response) => {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM metal_colors ORDER BY id ASC').all() as MetalColorRow[];
    const buf = await buildColorsExcel(rows);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader('Content-Disposition', 'attachment; filename="AdelCo-Colors.xlsx"');
    res.send(buf);
  });

  app.get('/api/colors/export/pdf', async (_req: Request, res: Response) => {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM metal_colors ORDER BY id ASC').all() as MetalColorRow[];
    const buf = await buildColorsPdf(rows);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="AdelCo-Colors.pdf"');
    res.send(buf);
  });

  // ============================================================================
  // METAL PRODUCTS
  // ============================================================================
  app.get('/api/products', (_req: Request, res: Response) => {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM metal_products ORDER BY id ASC').all() as MetalProductRow[];
    res.json(rows);
  });

  app.post('/api/products', uploadMemory.single('image'), async (req: Request, res: Response) => {
    try {
      const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
      const priceCents = parseCents(req.body.price_per_lf_cents);

      if (!name) {
        res.status(400).json({ error: 'Product name is required.' });
        return;
      }
      if (priceCents === null) {
        res.status(400).json({ error: 'Valid non-negative price per linear ft is required.' });
        return;
      }

      let imagePath: string | null = null;
      if (req.file) {
        imagePath = await processProductImage(req.file.buffer);
      }

      const db = getDb();
      const now = new Date().toISOString();
      const info = db
        .prepare(
          'INSERT INTO metal_products (name, image_path, price_per_lf_cents, is_available, created_at) VALUES (?, ?, ?, 1, ?)'
        )
        .run(name, imagePath, priceCents, now);
      res.status(201).json(db.prepare('SELECT * FROM metal_products WHERE id = ?').get(info.lastInsertRowid));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to create product.' });
    }
  });

  app.put('/api/products/:id', uploadMemory.single('image'), async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
      const priceCents = parseCents(req.body.price_per_lf_cents);
      const removeImage = req.body.remove_image === 'true' || req.body.remove_image === true;

      if (!Number.isInteger(id)) {
        res.status(400).json({ error: 'Invalid product ID.' });
        return;
      }
      if (!name) {
        res.status(400).json({ error: 'Product name is required.' });
        return;
      }
      if (priceCents === null) {
        res.status(400).json({ error: 'Valid price per linear ft is required.' });
        return;
      }

      const db = getDb();
      const existing = db.prepare('SELECT * FROM metal_products WHERE id = ?').get(id) as
        | MetalProductRow
        | undefined;
      if (!existing) {
        res.status(404).json({ error: 'Product not found.' });
        return;
      }

      let nextImagePath = existing.image_path;
      if (req.file) {
        nextImagePath = await processProductImage(req.file.buffer);
        removeImageFileIfUnused(existing.image_path);
      } else if (removeImage) {
        removeImageFileIfUnused(existing.image_path);
        nextImagePath = null;
      }

      db.prepare('UPDATE metal_products SET name = ?, image_path = ?, price_per_lf_cents = ? WHERE id = ?').run(
        name,
        nextImagePath,
        priceCents,
        id
      );
      res.json(db.prepare('SELECT * FROM metal_products WHERE id = ?').get(id));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to update product.' });
    }
  });

  app.patch('/api/products/:id/availability', (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const isAvailable = req.body.is_available ? 1 : 0;
    const db = getDb();
    const existing = db.prepare('SELECT * FROM metal_products WHERE id = ?').get(id);
    if (!existing) {
      res.status(404).json({ error: 'Product not found.' });
      return;
    }
    db.prepare('UPDATE metal_products SET is_available = ? WHERE id = ?').run(isAvailable, id);
    res.json(db.prepare('SELECT * FROM metal_products WHERE id = ?').get(id));
  });

  app.delete('/api/products/:id', (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const db = getDb();
    const existing = db.prepare('SELECT * FROM metal_products WHERE id = ?').get(id) as
      | MetalProductRow
      | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Product not found.' });
      return;
    }
    db.prepare('DELETE FROM metal_products WHERE id = ?').run(id);
    removeImageFileIfUnused(existing.image_path);
    res.json({ deleted: true });
  });

  app.get('/api/products/export/excel', async (_req: Request, res: Response) => {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM metal_products ORDER BY id ASC').all() as MetalProductRow[];
    const buf = await buildProductsExcel(rows);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader('Content-Disposition', 'attachment; filename="AdelCo-Products.xlsx"');
    res.send(buf);
  });

  app.get('/api/products/export/pdf', async (_req: Request, res: Response) => {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM metal_products ORDER BY id ASC').all() as MetalProductRow[];
    const buf = await buildProductsPdf(rows);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="AdelCo-Products.pdf"');
    res.send(buf);
  });

  // ============================================================================
  // DRAFT QUOTE EXPORTS (BEFORE ISSUING)
  // ============================================================================
  app.post('/api/quotes/draft/export/excel', async (req: Request, res: Response) => {
    try {
      const payload = await buildDraftPayloadForExport(req.body);
      const buf = await buildSingleQuoteExcel(payload);
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      res.setHeader('Content-Disposition', 'attachment; filename="AdelCo-Draft-Quote.xlsx"');
      res.send(buf);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Export failed.' });
    }
  });

  app.post('/api/quotes/draft/export/pdf', async (req: Request, res: Response) => {
    try {
      const payload = await buildDraftPayloadForExport(req.body);
      const buf = await buildSingleQuotePdf(payload);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename="AdelCo-Draft-Quote.pdf"');
      res.send(buf);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Export failed.' });
    }
  });

  // ============================================================================
  // ISSUED QUOTES
  // ============================================================================
  app.get('/api/quotes/export/excel', async (req: Request, res: Response) => {
    const quotes = queryIssuedQuotes(req.query);
    const buf = await buildIssuedQuotesExcel(quotes);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader('Content-Disposition', 'attachment; filename="AdelCo-Issued-Quotes.xlsx"');
    res.send(buf);
  });

  app.get('/api/quotes/export/pdf', async (req: Request, res: Response) => {
    const quotes = queryIssuedQuotes(req.query);
    const buf = await buildIssuedQuotesPdf(quotes);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="AdelCo-Issued-Quotes.pdf"');
    res.send(buf);
  });

  app.get('/api/quotes', (req: Request, res: Response) => {
    const quotes = queryIssuedQuotes(req.query);
    res.json(quotes);
  });

  app.get('/api/quotes/:id', (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const db = getDb();
    const quote = db.prepare('SELECT * FROM issued_quotes WHERE id = ?').get(id) as
      | IssuedQuoteRow
      | undefined;
    if (!quote) {
      res.status(404).json({ error: 'Issued quote not found.' });
      return;
    }
    const items = db
      .prepare('SELECT * FROM issued_quote_items WHERE quote_id = ? ORDER BY id ASC')
      .all(id) as IssuedQuoteItemRow[];
    res.json({ quote, items });
  });

  app.post('/api/quotes', (req: Request, res: Response) => {
    const quoteDate =
      typeof req.body.quote_date === 'string' && req.body.quote_date.trim()
        ? req.body.quote_date.trim()
        : new Date().toISOString().slice(0, 10);
    const customerName =
      typeof req.body.customer_name === 'string' && req.body.customer_name.trim()
        ? req.body.customer_name.trim()
        : null;
    const rawItems = Array.isArray(req.body.items) ? req.body.items : [];

    if (rawItems.length === 0) {
      res.status(400).json({ error: 'Add at least one product before issuing a quote.' });
      return;
    }

    const db = getDb();
    const getProd = db.prepare('SELECT * FROM metal_products WHERE id = ?');
    const getColor = db.prepare('SELECT * FROM metal_colors WHERE id = ?');

    try {
      const result = db.transaction(() => {
        const preparedItems: Array<{
          source_product_id: number;
          source_color_id: number;
          product_name: string;
          product_image_path: string | null;
          color_name: string;
          color_hex: string;
          product_price_per_lf_cents: number;
          color_price_per_lf_cents: number;
          combined_price_per_lf_cents: number;
          linear_feet: number;
          additional_costs_cents: number;
          additional_costs_description: string | null;
          line_total_cents: number;
        }> = [];

        let totalCents = 0;

        for (const row of rawItems) {
          if (!row.product_id || !row.color_id) {
            throw new Error('Every line item must have both a product and a color selected.');
          }
          const lf = Number(row.linear_feet);
          if (!Number.isFinite(lf) || lf <= 0) {
            throw new Error('Linear feet must be greater than 0 for every line item.');
          }

          let additionalCostsCents = 0;
          if (
            row.additional_costs_cents !== undefined &&
            row.additional_costs_cents !== null &&
            row.additional_costs_cents !== ''
          ) {
            const parsedAdd = parseCents(row.additional_costs_cents);
            if (parsedAdd === null) {
              throw new Error('Additional Costs must be a valid non-negative amount.');
            }
            additionalCostsCents = parsedAdd;
          }

          const additionalCostsDescription =
            typeof row.additional_costs_description === 'string' &&
            row.additional_costs_description.trim()
              ? row.additional_costs_description.trim().slice(0, 200)
              : null;

          const product = getProd.get(row.product_id) as MetalProductRow | undefined;
          if (!product || !product.is_available) {
            throw new Error('One or more selected products are unavailable or deleted.');
          }

          const color = getColor.get(row.color_id) as MetalColorRow | undefined;
          if (!color || !color.is_available) {
            throw new Error('One or more selected colors are unavailable or deleted.');
          }

          const combinedCents = product.price_per_lf_cents + color.price_per_lf_cents;
          const lineTotalCents = Math.round(lf * combinedCents) + additionalCostsCents;
          totalCents += lineTotalCents;

          const snapshotImagePath = copyProductImageToQuoteSnapshot(product.image_path);

          preparedItems.push({
            source_product_id: product.id,
            source_color_id: color.id,
            product_name: product.name,
            product_image_path: snapshotImagePath,
            color_name: color.name,
            color_hex: color.hex_code,
            product_price_per_lf_cents: product.price_per_lf_cents,
            color_price_per_lf_cents: color.price_per_lf_cents,
            combined_price_per_lf_cents: combinedCents,
            linear_feet: lf,
            additional_costs_cents: additionalCostsCents,
            additional_costs_description: additionalCostsDescription,
            line_total_cents: lineTotalCents,
          });
        }

        const quoteNumber = getNextQuoteNumber(db, quoteDate);
        const now = new Date().toISOString();

        const quoteInfo = db
          .prepare(
            'INSERT INTO issued_quotes (quote_number, quote_date, customer_name, total_cents, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)'
          )
          .run(quoteNumber, quoteDate, customerName, totalCents, null, now);

        const quoteId = Number(quoteInfo.lastInsertRowid);
        const insertItem = db.prepare(`
          INSERT INTO issued_quote_items (
            quote_id, source_product_id, source_color_id,
            product_name, product_image_path, color_name, color_hex,
            product_price_per_lf_cents, color_price_per_lf_cents, combined_price_per_lf_cents,
            linear_feet, additional_costs_cents, additional_costs_description, line_total_cents
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        for (const item of preparedItems) {
          insertItem.run(
            quoteId,
            item.source_product_id,
            item.source_color_id,
            item.product_name,
            item.product_image_path,
            item.color_name,
            item.color_hex,
            item.product_price_per_lf_cents,
            item.color_price_per_lf_cents,
            item.combined_price_per_lf_cents,
            item.linear_feet,
            item.additional_costs_cents,
            item.additional_costs_description,
            item.line_total_cents
          );
        }

        const quote = db.prepare('SELECT * FROM issued_quotes WHERE id = ?').get(quoteId) as IssuedQuoteRow;
        const items = db
          .prepare('SELECT * FROM issued_quote_items WHERE quote_id = ? ORDER BY id ASC')
          .all(quoteId) as IssuedQuoteItemRow[];

        return { quote, items };
      })();

      res.status(201).json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to issue quote.' });
    }
  });

  app.post('/api/quotes/:id/copy', (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const db = getDb();
    const quote = db.prepare('SELECT * FROM issued_quotes WHERE id = ?').get(id) as
      | IssuedQuoteRow
      | undefined;
    if (!quote) {
      res.status(404).json({ error: 'Issued quote not found.' });
      return;
    }

    const oldItems = db
      .prepare('SELECT * FROM issued_quote_items WHERE quote_id = ? ORDER BY id ASC')
      .all(id) as IssuedQuoteItemRow[];

    const getProd = db.prepare('SELECT * FROM metal_products WHERE id = ?');
    const getColor = db.prepare('SELECT * FROM metal_colors WHERE id = ?');

    const draftItems = oldItems.map((old) => {
      const prod = old.source_product_id
        ? (getProd.get(old.source_product_id) as MetalProductRow | undefined)
        : undefined;
      const color = old.source_color_id
        ? (getColor.get(old.source_color_id) as MetalColorRow | undefined)
        : undefined;

      const productOk = Boolean(prod && prod.is_available === 1);
      const colorOk = Boolean(color && color.is_available === 1);

      return {
        product_id: productOk && prod ? prod.id : null,
        color_id: colorOk && color ? color.id : null,
        linear_feet: old.linear_feet,
        additional_costs_cents: old.additional_costs_cents ?? 0,
        additional_costs_description: old.additional_costs_description ?? '',
        productIssue: productOk ? null : prod ? 'unavailable' : 'deleted',
        colorIssue: colorOk ? null : color ? 'unavailable' : 'deleted',
        fallbackProductName: old.product_name,
        fallbackProductImagePath: old.product_image_path,
        fallbackProductPriceCents: old.product_price_per_lf_cents,
        fallbackColorName: old.color_name,
        fallbackColorHex: old.color_hex,
        fallbackColorPriceCents: old.color_price_per_lf_cents,
      };
    });

    res.json({
      customer_name: quote.customer_name ?? '',
      quote_date: new Date().toISOString().slice(0, 10),
      source_quote_number: quote.quote_number,
      items: draftItems,
    });
  });

  app.delete('/api/quotes/:id', (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const db = getDb();
    const existing = db.prepare('SELECT * FROM issued_quotes WHERE id = ?').get(id);
    if (!existing) {
      res.status(404).json({ error: 'Issued quote not found.' });
      return;
    }

    const items = db
      .prepare('SELECT product_image_path FROM issued_quote_items WHERE quote_id = ?')
      .all(id) as Array<{ product_image_path: string | null }>;

    db.prepare('DELETE FROM issued_quotes WHERE id = ?').run(id);
    for (const item of items) {
      removeImageFileIfUnused(item.product_image_path);
    }

    res.json({ deleted: true });
  });

  app.get('/api/quotes/:id/export/excel', async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const db = getDb();
    const quote = db.prepare('SELECT * FROM issued_quotes WHERE id = ?').get(id) as
      | IssuedQuoteRow
      | undefined;
    if (!quote) {
      res.status(404).json({ error: 'Quote not found.' });
      return;
    }
    const items = db
      .prepare('SELECT * FROM issued_quote_items WHERE quote_id = ? ORDER BY id ASC')
      .all(id) as IssuedQuoteItemRow[];
    const buf = await buildSingleQuoteExcel({
      quote_number: quote.quote_number,
      quote_date: quote.quote_date,
      customer_name: quote.customer_name,
      total_cents: quote.total_cents,
      items,
    });
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="AdelCo-Quote-${quote.quote_number}.xlsx"`
    );
    res.send(buf);
  });

  app.get('/api/quotes/:id/export/pdf', async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const db = getDb();
    const quote = db.prepare('SELECT * FROM issued_quotes WHERE id = ?').get(id) as
      | IssuedQuoteRow
      | undefined;
    if (!quote) {
      res.status(404).json({ error: 'Quote not found.' });
      return;
    }
    const items = db
      .prepare('SELECT * FROM issued_quote_items WHERE quote_id = ? ORDER BY id ASC')
      .all(id) as IssuedQuoteItemRow[];
    const buf = await buildSingleQuotePdf({
      quote_number: quote.quote_number,
      quote_date: quote.quote_date,
      customer_name: quote.customer_name,
      total_cents: quote.total_cents,
      items,
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="AdelCo-Quote-${quote.quote_number}.pdf"`
    );
    res.send(buf);
  });

  // ============================================================================
  // SETTINGS & BACKUP / RESTORE
  // ============================================================================
  app.get('/api/settings', (_req: Request, res: Response) => {
    res.json({
      quote_prefix: getSetting('quote_prefix', ''),
    });
  });

  app.put('/api/settings', (req: Request, res: Response) => {
    const raw = typeof req.body.quote_prefix === 'string' ? req.body.quote_prefix : '';
    const cleaned = raw.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 8);
    setSetting('quote_prefix', cleaned);
    res.json({ quote_prefix: cleaned });
  });

  app.get('/api/backup/download', async (_req: Request, res: Response) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adelco-backup-'));
    const tempDbPath = path.join(tempDir, 'adelco.db');

    try {
      const db = getDb();
      await db.backup(tempDbPath);

      const stamp = new Date().toISOString().slice(0, 10);
      const zip = new AdmZip();
      zip.addLocalFile(tempDbPath, '', 'adelco.db');
      if (fs.existsSync(IMAGES_DIR)) {
        zip.addLocalFolder(IMAGES_DIR, 'images');
      }
      const zipBuffer = zip.toBuffer();

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="AdelCo-Backup-${stamp}.zip"`);
      res.send(zipBuffer);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({ error: err instanceof Error ? err.message : 'Backup failed.' });
      }
    } finally {
      setTimeout(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }, 5000);
    }
  });

  app.post('/api/backup/restore', uploadMemory.single('backup'), (req: Request, res: Response) => {
    if (!req.file) {
      res.status(400).json({ error: 'Please select a backup .zip file.' });
      return;
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adelco-restore-'));
    try {
      const zip = new AdmZip(req.file.buffer);
      zip.extractAllTo(tempDir, true);

      const restoredDbPath = path.join(tempDir, 'adelco.db');
      if (!fs.existsSync(restoredDbPath)) {
        res.status(400).json({ error: 'Invalid backup archive: adelco.db not found.' });
        return;
      }

      // Validate SQLite integrity and required tables before replacing live DB
      const testDb = new Database(restoredDbPath, { readonly: true });
      const tables = testDb
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>;
      testDb.close();

      const tableNames = new Set(tables.map((t) => t.name));
      const required = ['metal_colors', 'metal_products', 'issued_quotes', 'issued_quote_items'];
      for (const reqTable of required) {
        if (!tableNames.has(reqTable)) {
          res.status(400).json({ error: `Invalid backup database: missing table ${reqTable}.` });
          return;
        }
      }

      closeDb();
      ensureDataDirs();

      // Remove stale WAL/SHM files before copying restored DB
      for (const suffix of ['', '-wal', '-shm']) {
        const target = `${DB_PATH}${suffix}`;
        if (fs.existsSync(target)) {
          fs.unlinkSync(target);
        }
      }
      fs.copyFileSync(restoredDbPath, DB_PATH);

      const restoredImagesDir = path.join(tempDir, 'images');
      if (fs.existsSync(restoredImagesDir)) {
        fs.rmSync(IMAGES_DIR, { recursive: true, force: true });
        fs.cpSync(restoredImagesDir, IMAGES_DIR, { recursive: true });
      }
      fs.mkdirSync(PRODUCT_IMAGES_DIR, { recursive: true });
      fs.mkdirSync(QUOTE_IMAGES_DIR, { recursive: true });

      reloadDb();
      res.json({ restored: true });
    } catch (err) {
      reloadDb();
      res.status(400).json({ error: err instanceof Error ? err.message : 'Restore failed.' });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ============================================================================
  // VITE / STATIC SERVING
  // ============================================================================
  const httpServer = http.createServer(app);
  const distDir = path.resolve(process.cwd(), 'dist');
  const isProduction = process.env.NODE_ENV === 'production' && fs.existsSync(distDir);

  if (isProduction) {
    app.use(express.static(distDir));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const disableHmr = process.env.DISABLE_HMR === 'true';
    const vite = await createViteServer({
      server: disableHmr
        ? { middlewareMode: true, hmr: false, ws: false }
        : { middlewareMode: true, hmr: { server: httpServer } },
      appType: 'spa',
    });

    if (disableHmr) {
      app.get('/@vite/client', async (_req: Request, res: Response, next) => {
        try {
          const result = await vite.transformRequest('/@vite/client');
          if (!result) {
            next();
            return;
          }
          const patched = result.code
            .replace('await wsTransport.connect(handlers);', 'return;')
            .replace('wsTransport.send(data);', 'return;');
          res.setHeader('Content-Type', 'application/javascript');
          res.send(patched);
        } catch {
          next();
        }
      });
    }

    app.use(vite.middlewares);
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`AdelCo Inc. app listening on http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
