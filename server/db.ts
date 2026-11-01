import { Pool, PoolClient } from 'pg';

let pgPool: Pool | null = null;

export const buildPoolConfig = () => {
    const isProduction = process.env.NODE_ENV === 'production';
    const maxConnections = parseInt(process.env.PG_POOL_MAX || '25', 10);
    const idleTimeoutMillis = parseInt(process.env.PG_IDLE_TIMEOUT_MS || '10000', 10);
    const connectionTimeoutMillis = parseInt(process.env.PG_CONNECTION_TIMEOUT_MS || '12000', 10);

    return {
        connectionString: process.env.POSTGRES_URL,
        ssl: isProduction ? { rejectUnauthorized: false } : false,
        max: Number.isFinite(maxConnections) && maxConnections > 0 ? maxConnections : 25,
        idleTimeoutMillis: Number.isFinite(idleTimeoutMillis) && idleTimeoutMillis > 0 ? idleTimeoutMillis : 10000,
        connectionTimeoutMillis: Number.isFinite(connectionTimeoutMillis) && connectionTimeoutMillis > 0 ? connectionTimeoutMillis : 12000,
    };
};

export const getPool = (): Pool => {
    if (!pgPool) {
        pgPool = new Pool(buildPoolConfig());
        pgPool.on('error', (err) => console.error('[DB POOL ERROR]', err));
    }
    return pgPool;
};

export const getPoolMetrics = () => {
    if (!pgPool) return { totalCount: 0, idleCount: 0, waitingCount: 0 };
    return {
        totalCount: pgPool.totalCount,
        idleCount: pgPool.idleCount,
        waitingCount: pgPool.waitingCount,
    };
};

const acquireClientWithRetry = async (pool: Pool, maxRetries = 2): Promise<PoolClient> => {
    let attempt = 0;
    while (true) {
        try {
            return await pool.connect();
        } catch (err: any) {
            attempt++;
            const isTimeout = err?.message?.includes('timeout exceeded') || err?.code === 'ETIMEDOUT';
            if (attempt > maxRetries || !isTimeout) {
                console.error('[DB POOL] Client acquisition failed:', {
                    attempt,
                    error: err?.message,
                    metrics: getPoolMetrics()
                });
                throw err;
            }
            const jitterMs = 100 * (attempt ** 2) + Math.floor(Math.random() * 80);
            await new Promise(res => setTimeout(res, jitterMs));
        }
    }
};

export const withDb = async <T>(callback: (client: PoolClient) => Promise<T>): Promise<T> => {
    const pool = getPool();
    const client = await acquireClientWithRetry(pool);
    let errorOccurred = false;
    try {
        return await callback(client);
    } catch (err) {
        errorOccurred = true;
        throw err;
    } finally {
        client.release(errorOccurred);
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
