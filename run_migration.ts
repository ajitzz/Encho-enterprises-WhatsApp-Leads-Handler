
import fs from 'fs';
import path from 'path';
import { withDb } from './server/db.js';
import dotenv from 'dotenv';

dotenv.config();

async function runMigration() {
    const migrationPath = path.join(process.cwd(), 'migrations_v3.sql');
    const sql = fs.readFileSync(migrationPath, 'utf8');

    console.log('Applying migration from:', migrationPath);

    try {
        await withDb(async (client) => {
            await client.query(sql);
        });
        console.log('Migration applied successfully.');
    } catch (error) {
        console.error('Migration failed:', error);
        process.exit(1);
    }
}

runMigration();
