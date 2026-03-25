
import { Router } from 'express';
import { withDb } from '../../../server/db.js';

const router = Router();

const resolveActor = (req: any) => {
    const role = String(req?.user?.role || '').toLowerCase();
    const staffId = String(req?.user?.staffId || '').trim();
    return { role, staffId };
};

const canViewStaffQueue = async (client: any, actor: { role: string; staffId: string }, targetStaffId: string) => {
    if (!targetStaffId) return false;
    if (actor.role === 'admin') return true;
    if (actor.staffId === targetStaffId) return true;
    if (actor.role !== 'manager') return false;

    const membership = await client.query(
        'SELECT manager_id FROM staff_members WHERE id = $1',
        [targetStaffId]
    );
    return membership.rows[0]?.manager_id === actor.staffId;
};

// 1. Action Center (Unified Inbox)
router.get('/action-center', async (req: any, res) => {
    const actor = resolveActor(req);
    const requestedStaffId = String(req.query?.staffId || '').trim();
    const targetStaffId = requestedStaffId || actor.staffId;

    if (!actor.staffId) return res.status(401).json({ error: 'Unauthorized' });

    try {
        const tasks = await withDb(async (client) => {
            const allowed = await canViewStaffQueue(client, actor, targetStaffId);
            if (!allowed) {
                return { error: { status: 403, message: 'Access denied for requested staff action center' } };
            }

            // Priority 1: New leads assigned to you (Urgent)
            const newLeads = await client.query(`
                SELECT id, name, phone_number, 'new_lead' as task_type, created_at as task_date
                FROM candidates 
                WHERE assigned_to = $1 AND lead_status = 'assigned'
                ORDER BY created_at DESC
            `, [targetStaffId]);

            // Priority 2: Reminders due now
            const reminders = await client.query(`
                SELECT
                    r.id,
                    c.name as lead_name,
                    c.id as lead_id,
                    'reminder' as task_type,
                    r.scheduled_at as task_date,
                    r.scheduled_at
                FROM lead_reminders r
                JOIN candidates c ON r.candidate_id = c.id
                WHERE r.staff_id = $1 AND r.status = 'pending' AND r.scheduled_at <= NOW()
                ORDER BY r.scheduled_at ASC
            `, [targetStaffId]);

            // Priority 3: Stale leads (No response in 4 hours)
            const staleLeads = await client.query(`
                SELECT id, name, phone_number, 'stale_lead' as task_type, last_action_at as task_date
                FROM candidates 
                WHERE assigned_to = $1 AND lead_status = 'assigned' 
                  AND (last_action_at <= NOW() - INTERVAL '4 hours' OR last_action_at IS NULL)
                ORDER BY last_action_at ASC
            `, [targetStaffId]);

            return {
                ownerStaffId: targetStaffId,
                newLeads: newLeads.rows,
                reminders: reminders.rows,
                staleLeads: staleLeads.rows
            };
        });
        if ((tasks as any)?.error) {
            return res.status((tasks as any).error.status).json({ error: (tasks as any).error.message });
        }
        res.json(tasks);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// 2. Managerial Command Center (Analytics)
router.get('/command-center', async (req: any, res) => {
    const actor = resolveActor(req);
    const requestedManagerId = String(req.query?.managerId || '').trim();
    const managerId = requestedManagerId || actor.staffId;

    if (!actor.staffId) return res.status(401).json({ error: 'Unauthorized' });
    if (!['manager', 'admin'].includes(actor.role)) return res.status(403).json({ error: 'Manager/admin only' });
    if (actor.role === 'manager' && managerId !== actor.staffId) {
        return res.status(403).json({ error: 'Managers can only view their own command center' });
    }

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

            // Conversion Velocity (daily closures in last 14 days)
            const velocity = await client.query(`
                SELECT
                    DATE(l.created_at) as date,
                    COUNT(*)::int as count
                FROM lead_activity_log l
                JOIN staff_members s ON l.staff_id = s.id
                WHERE (l.action = 'review_approved' OR (l.action = 'status_change' AND l.notes LIKE '%closed%'))
                  AND l.created_at >= NOW() - INTERVAL '14 days'
                  AND (s.id = $1 OR s.manager_id = $1)
                GROUP BY DATE(l.created_at)
                ORDER BY DATE(l.created_at) ASC
            `, [managerId]);

            // Lead Distribution Heatmap by staff
            const heatmap = await client.query(`
                SELECT
                    COALESCE(s.name, 'Unassigned') as name,
                    COUNT(*)::int as count
                FROM candidates c
                LEFT JOIN staff_members s ON c.assigned_to = s.id
                WHERE c.created_at >= NOW() - INTERVAL '14 days'
                  AND (s.id = $1 OR s.manager_id = $1)
                GROUP BY COALESCE(s.name, 'Unassigned')
                ORDER BY count DESC
            `, [managerId]);

            return {
                teamStats: teamStats.rows,
                conversionVelocity: velocity.rows,
                distributionHeatmap: heatmap.rows
            };
        });
        res.json(analytics);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// 3. Hierarchy overview for admin/manager supervision
router.get('/hierarchy-overview', async (req: any, res) => {
    const actor = resolveActor(req);
    if (!actor.staffId) return res.status(401).json({ error: 'Unauthorized' });
    if (!['admin', 'manager'].includes(actor.role)) return res.status(403).json({ error: 'Manager/admin only' });

    try {
        const payload = await withDb(async (client) => {
            const scopeFilter = actor.role === 'admin' ? '' : 'WHERE m.id = $1';
            const scopeParams = actor.role === 'admin' ? [] : [actor.staffId];

            const managers = await client.query(`
                SELECT
                    m.id as manager_id,
                    m.name as manager_name,
                    m.email as manager_email,
                    COUNT(DISTINCT s.id)::int as staff_count,
                    COUNT(DISTINCT c.id)::int as total_leads,
                    COUNT(DISTINCT CASE WHEN c.lead_status = 'closed' THEN c.id END)::int as closed_leads,
                    COUNT(DISTINCT CASE WHEN c.lead_status = 'review_pending' THEN c.id END)::int as review_pending_leads
                FROM staff_members m
                LEFT JOIN staff_members s ON s.manager_id = m.id AND s.role = 'staff'
                LEFT JOIN candidates c ON c.assigned_to = s.id
                ${scopeFilter}
                GROUP BY m.id, m.name, m.email
                ORDER BY total_leads DESC, m.name ASC
            `, scopeParams);

            const staffLoad = await client.query(`
                SELECT
                    s.id as staff_id,
                    s.name as staff_name,
                    s.email as staff_email,
                    m.id as manager_id,
                    m.name as manager_name,
                    COUNT(c.id)::int as total_leads,
                    COUNT(CASE WHEN c.lead_status IN ('assigned', 'claimed', 'review_pending') THEN 1 END)::int as active_leads,
                    COUNT(CASE WHEN c.lead_status = 'closed' THEN 1 END)::int as closed_leads,
                    MAX(c.last_action_at) as last_action_at
                FROM staff_members s
                LEFT JOIN staff_members m ON s.manager_id = m.id
                LEFT JOIN candidates c ON c.assigned_to = s.id
                WHERE s.role = 'staff'
                  AND ($1::text = 'admin' OR s.manager_id = $2)
                GROUP BY s.id, s.name, s.email, m.id, m.name
                ORDER BY active_leads DESC, total_leads DESC
            `, [actor.role, actor.staffId]);

            return {
                scope: actor.role,
                managers: managers.rows,
                staffLoad: staffLoad.rows
            };
        });

        res.json(payload);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

export default router;
