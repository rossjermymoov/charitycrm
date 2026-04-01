const express = require('express');
const Database = require('better-sqlite3');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Use RAILWAY_VOLUME_MOUNT_PATH for persistent storage on Railway, fallback to local ./data
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const upload = multer({ dest: path.join(DATA_DIR, 'uploads') });

app.use(express.json({ limit: '500mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Initialize database
const db = new Database(path.join(DATA_DIR, 'charities.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create tables if they don't exist
db.exec(`
  CREATE TABLE IF NOT EXISTS charities (
    id INTEGER PRIMARY KEY,
    charity_name TEXT NOT NULL,
    charity_number INTEGER,
    registration_status TEXT,
    email TEXT,
    phone TEXT,
    website TEXT,
    address TEXT,
    postcode TEXT,
    income REAL,
    expenditure REAL,
    activities TEXT,
    date_registered TEXT,
    -- CRM fields
    pipeline_stage TEXT DEFAULT 'Lead',
    rag_status TEXT DEFAULT 'red',
    last_contacted TEXT,
    notes TEXT DEFAULT '',
    assigned_to TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_charities_email ON charities(email);
  CREATE INDEX IF NOT EXISTS idx_charities_phone ON charities(phone);
  CREATE INDEX IF NOT EXISTS idx_charities_name ON charities(charity_name);
  CREATE INDEX IF NOT EXISTS idx_charities_pipeline ON charities(pipeline_stage);
  CREATE INDEX IF NOT EXISTS idx_charities_rag ON charities(rag_status);
  CREATE INDEX IF NOT EXISTS idx_charities_postcode ON charities(postcode);

  CREATE VIRTUAL TABLE IF NOT EXISTS charities_fts USING fts5(
    charity_name, email, phone, postcode, address, activities,
    content='charities',
    content_rowid='id'
  );

  -- Triggers to keep FTS in sync
  CREATE TRIGGER IF NOT EXISTS charities_ai AFTER INSERT ON charities BEGIN
    INSERT INTO charities_fts(rowid, charity_name, email, phone, postcode, address, activities)
    VALUES (new.id, new.charity_name, new.email, new.phone, new.postcode, new.address, new.activities);
  END;

  CREATE TRIGGER IF NOT EXISTS charities_ad AFTER DELETE ON charities BEGIN
    INSERT INTO charities_fts(charities_fts, rowid, charity_name, email, phone, postcode, address, activities)
    VALUES ('delete', old.id, old.charity_name, old.email, old.phone, old.postcode, old.address, old.activities);
  END;

  CREATE TRIGGER IF NOT EXISTS charities_au AFTER UPDATE ON charities BEGIN
    INSERT INTO charities_fts(charities_fts, rowid, charity_name, email, phone, postcode, address, activities)
    VALUES ('delete', old.id, old.charity_name, old.email, old.phone, old.postcode, old.address, old.activities);
    INSERT INTO charities_fts(rowid, charity_name, email, phone, postcode, address, activities)
    VALUES (new.id, new.charity_name, new.email, new.phone, new.postcode, new.address, new.activities);
  END;
`);

// ============ API ROUTES ============

// GET /api/charities - Paginated list with search & filters
app.get('/api/charities', (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(10, parseInt(req.query.limit) || 25));
    const offset = (page - 1) * limit;
    const search = (req.query.search || '').trim();
    const pipeline = req.query.pipeline || '';
    const rag = req.query.rag || '';
    const hasEmail = req.query.hasEmail;
    const hasPhone = req.query.hasPhone;
    const sortBy = req.query.sortBy || 'charity_name';
    const sortDir = req.query.sortDir === 'desc' ? 'DESC' : 'ASC';

    const allowedSorts = ['charity_name', 'email', 'phone', 'income', 'expenditure', 'pipeline_stage', 'rag_status', 'last_contacted', 'updated_at', 'postcode'];
    const safeSort = allowedSorts.includes(sortBy) ? sortBy : 'charity_name';

    let conditions = [];
    let params = {};

    if (search) {
      // Use FTS for search
      conditions.push(`c.id IN (SELECT rowid FROM charities_fts WHERE charities_fts MATCH @search)`);
      // Escape FTS special chars and add prefix matching
      const ftsSearch = search.replace(/['"*()]/g, '').split(/\s+/).map(t => `"${t}"*`).join(' ');
      params.search = ftsSearch;
    }

    if (pipeline) {
      conditions.push(`c.pipeline_stage = @pipeline`);
      params.pipeline = pipeline;
    }

    if (rag) {
      conditions.push(`c.rag_status = @rag`);
      params.rag = rag;
    }

    if (hasEmail === 'true') {
      conditions.push(`c.email IS NOT NULL AND c.email != ''`);
    }

    if (hasPhone === 'true') {
      conditions.push(`c.phone IS NOT NULL AND c.phone != ''`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countStmt = db.prepare(`SELECT COUNT(*) as total FROM charities c ${where}`);
    const { total } = countStmt.get(params);

    const dataStmt = db.prepare(`
      SELECT * FROM charities c ${where}
      ORDER BY ${safeSort} ${sortDir}
      LIMIT @limit OFFSET @offset
    `);

    const rows = dataStmt.all({ ...params, limit, offset });

    res.json({
      data: rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      }
    });
  } catch (err) {
    console.error('Error fetching charities:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/charities/:id - Single charity
app.get('/api/charities/:id', (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM charities WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/charities/:id - Update CRM fields
app.patch('/api/charities/:id', (req, res) => {
  try {
    const allowed = ['pipeline_stage', 'rag_status', 'last_contacted', 'notes', 'assigned_to'];
    const updates = [];
    const params = { id: parseInt(req.params.id) };

    for (const field of allowed) {
      if (req.body[field] !== undefined) {
        updates.push(`${field} = @${field}`);
        params[field] = req.body[field];
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    updates.push(`updated_at = datetime('now')`);

    const stmt = db.prepare(`UPDATE charities SET ${updates.join(', ')} WHERE id = @id`);
    const result = stmt.run(params);

    if (result.changes === 0) return res.status(404).json({ error: 'Not found' });

    const updated = db.prepare('SELECT * FROM charities WHERE id = ?').get(params.id);
    res.json(updated);
  } catch (err) {
    console.error('Error updating charity:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stats - Dashboard stats
app.get('/api/stats', (req, res) => {
  try {
    const total = db.prepare('SELECT COUNT(*) as count FROM charities').get().count;
    const pipeline = db.prepare(`
      SELECT pipeline_stage, COUNT(*) as count
      FROM charities GROUP BY pipeline_stage
    `).all();
    const rag = db.prepare(`
      SELECT rag_status, COUNT(*) as count
      FROM charities GROUP BY rag_status
    `).all();
    const contacted = db.prepare(`
      SELECT COUNT(*) as count FROM charities WHERE last_contacted IS NOT NULL
    `).get().count;

    res.json({ total, pipeline, rag, contacted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/charities/bulk/update - Bulk update
app.patch('/api/charities/bulk/update', (req, res) => {
  try {
    const { ids, updates } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'No IDs provided' });
    }

    const allowed = ['pipeline_stage', 'rag_status', 'last_contacted', 'notes', 'assigned_to'];
    const setClauses = [];
    const params = {};

    for (const field of allowed) {
      if (updates[field] !== undefined) {
        setClauses.push(`${field} = @${field}`);
        params[field] = updates[field];
      }
    }

    if (setClauses.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    setClauses.push(`updated_at = datetime('now')`);

    const placeholders = ids.map((_, i) => `@id${i}`).join(',');
    ids.forEach((id, i) => { params[`id${i}`] = id; });

    const stmt = db.prepare(`UPDATE charities SET ${setClauses.join(', ')} WHERE id IN (${placeholders})`);
    const result = stmt.run(params);

    res.json({ updated: result.changes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Export CSV
app.get('/api/export/csv', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM charities ORDER BY charity_name').all();

    const headers = ['ID', 'Name', 'Charity Number', 'Status', 'Email', 'Phone', 'Website', 'Address', 'Postcode', 'Income', 'Expenditure', 'Pipeline Stage', 'RAG Status', 'Last Contacted', 'Notes', 'Assigned To'];

    const csvRows = rows.map(r => [
      r.id, `"${(r.charity_name || '').replace(/"/g, '""')}"`, r.charity_number, r.registration_status,
      r.email, r.phone, r.website, `"${(r.address || '').replace(/"/g, '""')}"`, r.postcode,
      r.income, r.expenditure, r.pipeline_stage, r.rag_status, r.last_contacted,
      `"${(r.notes || '').replace(/"/g, '""')}"`, r.assigned_to
    ].join(','));

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=charities_crm_export.csv');
    res.send([headers.join(','), ...csvRows].join('\n'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/import - Upload and import JSON file via the web UI
let importInProgress = false;
app.post('/api/import', upload.single('file'), async (req, res) => {
  if (importInProgress) {
    return res.status(409).json({ error: 'Import already in progress' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  importInProgress = true;

  try {
    const raw = fs.readFileSync(req.file.path, 'utf-8').replace(/^\uFEFF/, '');
    const data = JSON.parse(raw);

    const filtered = data.filter(r => r.charity_contact_email || r.charity_contact_phone);

    // Drop and recreate
    db.exec(`DROP TABLE IF EXISTS charities_fts`);
    db.exec(`DROP TABLE IF EXISTS charities`);
    db.exec(`
      CREATE TABLE charities (
        id INTEGER PRIMARY KEY,
        charity_name TEXT NOT NULL,
        charity_number INTEGER,
        registration_status TEXT,
        email TEXT,
        phone TEXT,
        website TEXT,
        address TEXT,
        postcode TEXT,
        income REAL,
        expenditure REAL,
        activities TEXT,
        date_registered TEXT,
        pipeline_stage TEXT DEFAULT 'Lead',
        rag_status TEXT DEFAULT 'red',
        last_contacted TEXT,
        notes TEXT DEFAULT '',
        assigned_to TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_charities_email ON charities(email);
      CREATE INDEX idx_charities_phone ON charities(phone);
      CREATE INDEX idx_charities_name ON charities(charity_name);
      CREATE INDEX idx_charities_pipeline ON charities(pipeline_stage);
      CREATE INDEX idx_charities_rag ON charities(rag_status);
      CREATE INDEX idx_charities_postcode ON charities(postcode);
    `);

    const insert = db.prepare(`
      INSERT INTO charities (id, charity_name, charity_number, registration_status, email, phone, website, address, postcode, income, expenditure, activities, date_registered)
      VALUES (@id, @name, @charityNumber, @status, @email, @phone, @website, @address, @postcode, @income, @expenditure, @activities, @registered)
    `);

    const BATCH = 5000;
    const insertBatch = db.transaction((rows) => {
      for (const r of rows) insert.run(r);
    });

    let batch = [];
    for (const r of filtered) {
      const addr = [r.charity_contact_address1, r.charity_contact_address2, r.charity_contact_address3, r.charity_contact_address4, r.charity_contact_address5]
        .filter(Boolean).join(', ');

      batch.push({
        id: r.organisation_number,
        name: r.charity_name || '',
        charityNumber: r.registered_charity_number,
        status: r.charity_registration_status || '',
        email: r.charity_contact_email || '',
        phone: r.charity_contact_phone || '',
        website: r.charity_contact_web || '',
        address: addr,
        postcode: r.charity_contact_postcode || '',
        income: r.latest_income,
        expenditure: r.latest_expenditure,
        activities: r.charity_activities || '',
        registered: r.date_of_registration ? r.date_of_registration.substring(0, 10) : '',
      });

      if (batch.length >= BATCH) {
        insertBatch(batch);
        batch = [];
      }
    }
    if (batch.length > 0) insertBatch(batch);

    // Build FTS
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS charities_fts USING fts5(
        charity_name, email, phone, postcode, address, activities,
        content='charities', content_rowid='id'
      );
      INSERT INTO charities_fts(rowid, charity_name, email, phone, postcode, address, activities)
        SELECT id, charity_name, email, phone, postcode, address, activities FROM charities;

      CREATE TRIGGER IF NOT EXISTS charities_ai AFTER INSERT ON charities BEGIN
        INSERT INTO charities_fts(rowid, charity_name, email, phone, postcode, address, activities)
        VALUES (new.id, new.charity_name, new.email, new.phone, new.postcode, new.address, new.activities);
      END;
      CREATE TRIGGER IF NOT EXISTS charities_ad AFTER DELETE ON charities BEGIN
        INSERT INTO charities_fts(charities_fts, rowid, charity_name, email, phone, postcode, address, activities)
        VALUES ('delete', old.id, old.charity_name, old.email, old.phone, old.postcode, old.address, old.activities);
      END;
      CREATE TRIGGER IF NOT EXISTS charities_au AFTER UPDATE ON charities BEGIN
        INSERT INTO charities_fts(charities_fts, rowid, charity_name, email, phone, postcode, address, activities)
        VALUES ('delete', old.id, old.charity_name, old.email, old.phone, old.postcode, old.address, old.activities);
        INSERT INTO charities_fts(rowid, charity_name, email, phone, postcode, address, activities)
        VALUES (new.id, new.charity_name, new.email, new.phone, new.postcode, new.address, new.activities);
      END;
    `);

    // Cleanup uploaded file
    fs.unlinkSync(req.file.path);

    res.json({ success: true, total: data.length, imported: filtered.length });
  } catch (err) {
    console.error('Import error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    importInProgress = false;
  }
});

// GET /api/import/status - Check if data has been imported
app.get('/api/import/status', (req, res) => {
  try {
    const count = db.prepare('SELECT COUNT(*) as count FROM charities').get().count;
    res.json({ hasData: count > 0, count, importInProgress });
  } catch {
    res.json({ hasData: false, count: 0, importInProgress });
  }
});

app.listen(PORT, () => {
  const count = db.prepare('SELECT COUNT(*) as count FROM charities').get().count;
  console.log(`\n  🏛️  Charity CRM running at http://localhost:${PORT}`);
  console.log(`  📊 ${count.toLocaleString()} charities loaded\n`);
  if (count === 0) {
    console.log(`  ⚠️  No data found. Run: npm run import -- path/to/publicextract.charity.json\n`);
  }
});
