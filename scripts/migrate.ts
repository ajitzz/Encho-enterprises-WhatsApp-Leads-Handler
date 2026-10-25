#!/usr/bin/env node
import dotenv from 'dotenv';
dotenv.config();

import { getPool } from '../server/db.js';
import { initDatabase, ensurePerformanceIndexes } from '../server.ts';

async function runMigration() {
    console.log('[Migration] Connecting to database...');
    const pool = getPool();
    const client = await pool.connect();
    try {
        console.log('[Migration] Executing schema migrations...');
        await initDatabase(client);
        console.log('[Migration] Schema migrations completed.');

        console.log('[Migration] Verifying performance indexes...');
        await ensurePerformanceIndexes(client);
        console.log('[Migration] Performance indexes verified.');
        
        console.log('[Migration] SUCCESS: All migrations applied cleanly.');
        process.exit(0);
    } catch (err: any) {
        console.error('[Migration] FAILED:', err?.message || err);
        process.exit(1);
    } finally {
        client.release();
    }
}

runMigration();
