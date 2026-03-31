const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const jsonPath = process.argv[2];
if (!jsonPath) {
  console.error('Usage: node import.js <path-to-charity-json>');
  console.error('Example: node import.js ./publicextract.charity.json');
  process.exit(1);
}

if (!fs.existsSync(jsonPath)) {
  console.error(`File not found: ${jsonPath}`);
  process.exit(1);
}

console.log(`Reading ${jsonPath}...`);
const raw = fs.readFileSync(jsonPath, 'utf-8').replace(/^\uFEFF/, ''); // Strip BOM
const data = JSON.parse(raw);
console.log(`Parsed ${data.length.toLocaleString()} total records`);

// Filter: only records with email or phone
const filtered = data.filter(r => r.charity_contact_email || r.charity_contact_phone);
console.log(`${filtered.length.toLocaleString()} records have email or phone`);

// Open/create database
const dbPath = path.join(__dirname, 'data', 'charities.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// Create table
db.exec(`
  DROP TABLE IF EXISTS charities;

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

// Insert in batches
const insert = db.prepare(`
  INSERT INTO charities (id, charity_name, charity_number, registration_status, email, phone, website, address, postcode, income, expenditure, activities, date_registered)
  VALUES (@id, @name, @charityNumber, @status, @email, @phone, @website, @address, @postcode, @income, @expenditure, @activities, @registered)
`);

const BATCH = 5000;
const insertBatch = db.transaction((rows) => {
  for (const r of rows) {
    insert.run(r);
  }
});

let count = 0;
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
    count += batch.length;
    process.stdout.write(`\r  Imported ${count.toLocaleString()} / ${filtered.length.toLocaleString()}`);
    batch = [];
  }
}

if (batch.length > 0) {
  insertBatch(batch);
  count += batch.length;
}

// Build FTS index
console.log(`\n  Building full-text search index...`);
db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS charities_fts USING fts5(
    charity_name, email, phone, postcode, address, activities,
    content='charities',
    content_rowid='id'
  );

  INSERT INTO charities_fts(rowid, charity_name, email, phone, postcode, address, activities)
    SELECT id, charity_name, email, phone, postcode, address, activities FROM charities;

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

console.log(`\n  ✅ Done! ${count.toLocaleString()} charities imported to ${dbPath}`);
console.log(`  Run 'npm start' to launch the CRM\n`);

db.close();
