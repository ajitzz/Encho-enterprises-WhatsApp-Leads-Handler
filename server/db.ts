import { Pool, PoolClient } from 'pg';

let pgPool: Pool | null = null;

export const buildPoolConfig = () => {
    const isProduction = process.env.NODE_ENV === 'production';
    const maxConnections = parseInt(process.env.PG_POOL_MAX || '20', 10);
    const idleTimeoutMillis = parseInt(process.env.PG_IDLE_TIMEOUT_MS || '10000', 10);

    return {
        connectionString: process.env.POSTGRES_URL,
        ssl: isProduction ? { rejectUnauthorized: false } : false,
        max: Number.isFinite(maxConnections) && maxConnections > 0 ? maxConnections : 20,
        idleTimeoutMillis: Number.isFinite(idleTimeoutMillis) && idleTimeoutMillis > 0 ? idleTimeoutMillis : 10000,
        connectionTimeoutMillis: 5000,
    };
};

export const getPool = (): Pool => {
    if (!pgPool) {
        pgPool = new Pool(buildPoolConfig());
        pgPool.on('error', (err) => console.error('[DB POOL ERROR]', err));
    }
    return pgPool;
};

export const withDb = async <T>(callback: (client: PoolClient) => Promise<T>): Promise<T> => {
    const pool = getPool();
    const client = await pool.connect();
    try {
        return await callback(client);
    } finally {
        client.release();
    }
};

export const withTransaction = async <T>(callback: (client: PoolClient) => Promise<T>): Promise<T> => {
    return withDb(async (client) => {
        await client.query('BEGIN');
        try {
            const result = await callback(client);
            await client.query('COMMIT');
            return result;
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        }
    });
};

export const query = async (text: string, params?: any[]) => {
    return getPool().query(text, params);
};
