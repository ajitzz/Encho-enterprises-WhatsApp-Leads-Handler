import { getPool } from './server/db.js';
import fs from 'fs';

async function run() {
    const pool = getPool();
    const client = await pool.connect();
    try {
        console.log("Running migrations_v3.sql...");
        const sql = fs.readFileSync('migrations_v3.sql', 'utf8');
        await client.query(sql);
        console.log("Success!");
    } catch (e) {
        console.error(e);
    } finally {
        client.release();
        process.exit(0);
    }
}

run();
