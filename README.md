# Charity CRM

A lightweight CRM for tracking sales outreach to UK charities. Built with Node.js, Express, and SQLite.

## Features

- **170K+ charities** with email/phone contact details from the UK Charity Commission
- **Full-text search** across name, email, phone, postcode, address
- **Pipeline tracking**: Lead → Contacted → Meeting Booked → Proposal Sent → Won / Lost
- **RAG status**: Red / Amber / Green visual indicators
- **Inline editing**: Last contacted date, notes, assigned to
- **Bulk actions**: Update pipeline stage or RAG status for multiple charities at once
- **CSV export**: Export all data including CRM fields
- **Server-side pagination**: Handles large datasets efficiently

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Import charity data (place your JSON file in the project root)
npm run import -- ./publicextract.charity.json

# 3. Start the CRM
npm start
```

Then open http://localhost:3000

## Data Source

Download the charity extract from the [Charity Commission](https://register-of-charities.charitycommission.gov.uk/register/full-register-download) and place the JSON file in the project root before running the import.

## Tech Stack

- **Backend**: Node.js + Express
- **Database**: SQLite (via better-sqlite3) with FTS5 full-text search
- **Frontend**: Vanilla HTML/CSS/JS (no build step)
