'use strict';

/* =========================================================================
   Database migration script for Contrail
   Creates tables for device tokens and follower relationships
   ========================================================================= */

const pg = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable not set');
  console.log('For local testing, create a PostgreSQL database and set DATABASE_URL');
  console.log('Example: DATABASE_URL=postgresql://user:pass@localhost:5432/contrail');
  process.exit(1);
}

const SQL = `
-- Device tokens for push notifications
CREATE TABLE IF NOT EXISTS devices (
  id SERIAL PRIMARY KEY,
  channel VARCHAR(32) NOT NULL,
  token TEXT NOT NULL UNIQUE,
  platform VARCHAR(10) NOT NULL CHECK (platform IN ('ios', 'android', 'web')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_devices_channel ON devices(channel);
CREATE INDEX IF NOT EXISTS idx_devices_token ON devices(token);

-- Follower relationships (pilot channel -> follower channel)
CREATE TABLE IF NOT EXISTS followers (
  id SERIAL PRIMARY KEY,
  pilot_channel VARCHAR(32) NOT NULL,
  follower_channel VARCHAR(32) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(pilot_channel, follower_channel)
);

CREATE INDEX IF NOT EXISTS idx_followers_pilot ON followers(pilot_channel);
CREATE INDEX IF NOT EXISTS idx_followers_follower ON followers(follower_channel);

-- Flight events log (for debugging and history)
CREATE TABLE IF NOT EXISTS flight_events (
  id SERIAL PRIMARY KEY,
  channel VARCHAR(32) NOT NULL,
  event_type VARCHAR(20) NOT NULL CHECK (event_type IN ('start', 'end')),
  tail VARCHAR(10),
  pilot_name VARCHAR(50),
  data JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_flight_events_channel ON flight_events(channel);
CREATE INDEX IF NOT EXISTS idx_flight_events_created ON flight_events(created_at);
`;

async function migrate() {
  const client = new pg.Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  
  try {
    await client.connect();
    console.log('Connected to database');
    
    await client.query(SQL);
    console.log('✓ Migration complete');
    console.log('✓ Tables created: devices, followers, flight_events');
    
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

migrate();
