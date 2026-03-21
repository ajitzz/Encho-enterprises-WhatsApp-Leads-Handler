
import { Router } from 'express';
import { withDb } from '../../../server/db.js';

const router = Router();

// 1. Action Center (Unified Inbox)
router.get('/action-center/:staffId', async (req, res) => {
    const { staffId } = req.params;
    try {
        const tasks = await withDb(async (client) => {
            // Priority 1: New leads assigned to you (Urgent)
            const newLeads = await client.query(`
                SELECT id, name, phone_number, 'new_lead' as task_type, created_at as task_date
                FROM candidates 
                WHERE assigned_to = $1 AND lead_status = 'assigned'
                ORDER BY created_at DESC
            `, [staffId]);

            // Priority 2: Reminders due now
            const reminders = await client.query(`
                SELECT r.id, c.name as candidate_name, c.id as candidate_id, 'reminder' as task_type, r.scheduled_at as task_date
                FROM lead_reminders r
                JOIN candidates c ON r.candidate_id = c.id
                WHERE r.staff_id = $1 AND r.status = 'pending' AND r.scheduled_at <= NOW()
                ORDER BY r.scheduled_at ASC
            `, [staffId]);

            // Priority 3: Stale leads (No response in 4 hours)
            const staleLeads = await client.query(`
                SELECT id, name, phone_number, 'stale_lead' as task_type, last_action_at as task_date
                FROM candidates 
                WHERE assigned_to = $1 AND lead_status = 'assigned' 
                  AND (last_action_at <= NOW() - INTERVAL '4 hours' OR last_action_at IS NULL)
                ORDER BY last_action_at ASC
            `, [staffId]);

            return {
                newLeads: newLeads.rows,
                reminders: reminders.rows,
                staleLeads: staleLeads.rows
            };
        });
        res.json(tasks);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// 2. Managerial Command Center (Analytics)
router.get('/command-center/:managerId', async (req, res) => {
    const { managerId } = req.params;
    try {
        const analytics = await withDb(async (client) => {
            // Team Performance
            const teamStats = await client.query(`
                SELECT s.id, s.name, 
                       (SELECT COUNT(*) FROM candidates c WHERE c.assigned_to = s.id AND c.lead_status = 'closed') as closed_leads,
                       (SELECT COUNT(*) FROM candidates c WHERE c.assigned_to = s.id AND c.lead_status NOT IN ('closed', 'archived', 'rejected')) as active_leads,
                       s.max_capacity,
                       s.avg_response_time_seconds
                FROM staff_members s
                WHERE s.manager_id = $1 OR s.id = $1
                ORDER BY closed_leads DESC
            `, [managerId]);

            // Conversion Velocity (Average time from assigned to closed)
            const velocity = await client.query(`
                SELECT AVG(EXTRACT(EPOCH FROM (l.created_at - c.created_at))) as avg_seconds_to_close
                FROM lead_activity_log l
                JOIN candidates c ON l.candidate_id = c.id
                WHERE l.action = 'review_approved' OR (l.action = 'status_change' AND l.notes LIKE '%closed%')
            `);

            // Lead Distribution Heatmap (Last 7 days)
            const heatmap = await client.query(`
                SELECT DATE(created_at) as date, COUNT(*) as lead_count
                FROM candidates
                WHERE created_at >= NOW() - INTERVAL '7 days'
                GROUP BY DATE(created_at)
                ORDER BY DATE(created_at) ASC
            `);

            return {
                teamStats: teamStats.rows,
                avgSecondsToClose: velocity.rows[0]?.avg_seconds_to_close || 0,
                heatmap: heatmap.rows
            };
        });
        res.json(analytics);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

export default router;
