
import { withDb } from '../../../server/db.js';
import { log } from '../../shared/infra/logger.js';

export async function runNurtureTriggers() {
    log({ module: 'automation', message: 'nurture.run_started' });

    try {
        await withDb(async (client) => {
            // 1. Find stale leads (Contacted status for 24 hours with no update)
            const staleLeads = await client.query(`
                SELECT id, assigned_to, name, phone_number
                FROM candidates
                WHERE lead_status = 'contacted' 
                  AND (last_action_at <= NOW() - INTERVAL '24 hours' OR last_action_at IS NULL)
                  AND nurture_status = 'none'
            `);

            for (const lead of staleLeads.rows) {
                // 2. Escalate to manager
                const staffRes = await client.query("SELECT manager_id FROM staff_members WHERE id = $1", [lead.assigned_to]);
                const managerId = staffRes.rows[0]?.manager_id;

                if (managerId) {
                    await client.query(`
                        INSERT INTO audit_logs (actor_id, entity_type, entity_id, action, reason)
                        VALUES ($1, 'lead', $2, 'escalated', 'Lead stale for 24+ hours in contacted status.')
                    `, [managerId, lead.id]);

                    await client.query("UPDATE candidates SET nurture_status = 'escalated' WHERE id = $1", [lead.id]);

                    // 3. Log activity
                    await client.query(`
                        INSERT INTO lead_activity_log (candidate_id, staff_id, action, notes)
                        VALUES ($1, $2, 'auto_escalated', 'Lead automatically escalated to manager due to inactivity.')
                    `, [lead.id, managerId, 'Lead stale for 24+ hours.']);

                    log({ module: 'automation', message: 'nurture.escalated', meta: { candidateId: lead.id, managerId } });
                }
            }
        });
    } catch (error: any) {
        log({ level: 'error', module: 'automation', message: 'nurture.run_failed', meta: { error: error.message } });
    }
}
