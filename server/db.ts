import { Pool, PoolClient } from 'pg';

let pgPool: Pool | null = null;

export const buildPoolConfig = () => {
    const isProduction = process.env.NODE_ENV === 'production';
    return {
        connectionString: process.env.POSTGRES_URL,
        ssl: isProduction ? { rejectUnauthorized: false } : false,
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 2000,
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

export const query = async (text: string, params?: any[]) => {
    return getPool().query(text, params);
};
