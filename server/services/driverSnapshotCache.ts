import crypto from 'crypto';
import { query } from '../db.js';

type DriverSnapshotRow = {
    id: string;
    phone_number: string;
    name: string | null;
    stage: string;
    lead_status?: string | null;
    assigned_to?: string | null;
    last_message: string | null;
    last_message_at: string | null;
    source: string | null;
    is_human_mode: boolean;
    is_hidden: boolean;
    is_terminated: boolean;
    created_at?: string | null;
    user_msg_count: number | string;
    user_media_count: number | string;
    var_count: number | string;
};

type DriverSnapshot = {
    drivers: any[];
    fingerprint: string;
};

const DRIVER_SNAPSHOT_CACHE_TTL_MS = Math.max(1_000, Number(process.env.DRIVER_SNAPSHOT_CACHE_TTL_MS || 5000));
const BOT_NODE_COUNT_CACHE_TTL_MS = Math.max(5_000, Number(process.env.BOT_NODE_COUNT_CACHE_TTL_MS || 60000));

let snapshotCache: { expiresAt: number; value: DriverSnapshot } | null = null;
let snapshotInFlight: Promise<DriverSnapshot> | null = null;
let totalNodesCache: { expiresAt: number; value: number } | null = null;

const parseNumeric = (input: number | string | null | undefined): number => {
    const parsed = Number.parseInt(String(input ?? 0), 10);
    return Number.isFinite(parsed) ? parsed : 0;
};

const getPublishedBotNodeCount = async (): Promise<number> => {
    const now = Date.now();
    if (totalNodesCache && totalNodesCache.expiresAt > now) {
        return totalNodesCache.value;
    }

    const botRes = await query("SELECT settings FROM bot_versions WHERE status = 'published' ORDER BY created_at DESC LIMIT 1");
    const publishedBot = botRes.rows[0];
    const totalNodes = publishedBot?.settings?.nodes?.length || 10;

    totalNodesCache = {
        value: totalNodes,
        expiresAt: now + BOT_NODE_COUNT_CACHE_TTL_MS,
    };

    return totalNodes;
};

const buildDriverSnapshot = async (): Promise<DriverSnapshot> => {
    const totalNodes = await getPublishedBotNodeCount();

    const result = await query(`
        WITH top_candidates AS (
            SELECT
                c.id,
                c.phone_number,
                c.name,
                c.stage,
                c.lead_status,
                c.assigned_to,
                c.last_message,
                c.last_message_at,
                c.source,
                c.is_human_mode,
                c.is_hidden,
                c.is_terminated,
                c.created_at,
                c.variables
            FROM candidates c
            WHERE COALESCE(c.is_hidden, FALSE) = FALSE
            ORDER BY c.last_message_at DESC NULLS LAST
            LIMIT 50
        ),
        msg_counts AS (
            SELECT
                cm.candidate_id,
                COUNT(*) FILTER (WHERE cm.direction = 'in')::int AS user_msg_count,
                COUNT(*) FILTER (
                    WHERE cm.direction = 'in'
                      AND cm.type IN ('image', 'video', 'audio', 'document', 'voice', 'sticker')
                )::int AS user_media_count
            FROM candidate_messages cm
            WHERE cm.candidate_id IN (SELECT id FROM top_candidates)
            GROUP BY cm.candidate_id
        )
        SELECT
            t.id,
            t.phone_number,
            t.name,
            t.stage,
            t.lead_status,
            t.assigned_to,
            t.last_message,
            t.last_message_at,
            t.source,
            t.is_human_mode,
            t.is_hidden,
            t.is_terminated,
            t.created_at,
            COALESCE(m.user_msg_count, 0) AS user_msg_count,
            COALESCE(m.user_media_count, 0) AS user_media_count,
            jsonb_object_length(COALESCE(t.variables, '{}'::jsonb))::int AS var_count
        FROM top_candidates t
        LEFT JOIN msg_counts m ON m.candidate_id = t.id
        ORDER BY t.last_message_at DESC NULLS LAST
    `);

    const rows = result.rows as DriverSnapshotRow[];
    const drivers = rows.map((row) => {
        const msgCount = parseNumeric(row.user_msg_count);
        const mediaCount = parseNumeric(row.user_media_count);
        const varCount = parseNumeric(row.var_count);

        let leadScore = (msgCount * 10) + (mediaCount * 50) + (varCount * 20);
        if (row.is_human_mode) leadScore += 100;

        const progress = Math.min(100, Math.round((varCount / Math.max(1, totalNodes)) * 100));

        return {
            id: row.id,
            phoneNumber: row.phone_number,
            phone_number: row.phone_number,
            name: row.name,
            status: row.stage,
            lead_status: row.lead_status,
            assigned_to: row.assigned_to,
            lastMessage: row.last_message,
            lastMessageTime: parseInt(row.last_message_at || '0', 10),
            source: row.source,
            isHumanMode: row.is_human_mode,
            isHidden: Boolean(row.is_hidden),
            isTerminated: Boolean(row.is_terminated),
            created_at: row.created_at,
            lead_score: leadScore,
            progress_percent: progress,
            user_msg_count: msgCount,
            user_media_count: mediaCount,
            var_count: varCount,
        };
    });

    const fingerprint = crypto
        .createHash('sha1')
        .update(JSON.stringify(drivers))
        .digest('hex');

    return { drivers, fingerprint };
};

export const getDriversSnapshotCached = async (): Promise<DriverSnapshot> => {
    const now = Date.now();
    if (snapshotCache && snapshotCache.expiresAt > now) {
        return snapshotCache.value;
    }

    if (snapshotInFlight) {
        return snapshotInFlight;
    }

    snapshotInFlight = buildDriverSnapshot()
        .then((value) => {
            snapshotCache = {
                value,
                expiresAt: Date.now() + DRIVER_SNAPSHOT_CACHE_TTL_MS,
            };
            return value;
        })
        .finally(() => {
            snapshotInFlight = null;
        });

    return snapshotInFlight;
};

export const invalidateDriversSnapshotCache = () => {
    snapshotCache = null;
};
