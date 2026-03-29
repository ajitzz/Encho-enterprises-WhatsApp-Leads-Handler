
import { Router } from 'express';
import { withDb } from '../../../server/db.js';
import { log } from '../../shared/infra/logger.js';

const router = Router();
const DECISION_STATUSES = ['approved', 'rejected', 'returned_for_call_again'] as const;

// Submit a lead for review
router.post('/:id/submit', async (req, res) => {
    const { id } = req.params;
    const actor = (req as any).user || {};
    const actorRole = String(actor.role || '').toLowerCase();
    const actorStaffId = String(actor.staffId || req.body?.staffId || '').trim();
    const closingDate = String(req.body?.closingDate || req.body?.closing_date || '').trim();
    const notes = String(req.body?.notes || '').trim();
    const screenshotUrl = req.body?.screenshotUrl || req.body?.screenshot_url || null;

    if (!actorStaffId) return res.status(401).json({ error: 'Unauthorized' });
    if (!closingDate) return res.status(400).json({ error: 'Closing date is required' });
    if (!notes) return res.status(400).json({ error: 'Notes are required' });

    try {
        await withDb(async (client) => {
            // 1. Check if lead exists and ensure actor has permission to submit review
            const leadRes = await client.query(`
                SELECT c.assigned_to, sm.manager_id
                FROM candidates c
                LEFT JOIN staff_members sm ON sm.id = c.assigned_to
                WHERE c.id = $1
            `, [id]);
            if (leadRes.rows.length === 0) return res.status(404).json({ error: 'Lead not found' });
            
            const lead = leadRes.rows[0];
            const isOwner = lead.assigned_to === actorStaffId;
            const isManagerOfOwner = lead.manager_id === actorStaffId;
            const canSubmit = actorRole === 'admin' || isOwner || (actorRole === 'manager' && isManagerOfOwner);
            if (!canSubmit) return res.status(403).json({ error: 'Lead not assigned to you or your team' });

            // 2. Get manager ID
            const reviewOwnerStaffId = isOwner ? actorStaffId : (lead.assigned_to || actorStaffId);
            const staffRes = await client.query("SELECT manager_id FROM staff_members WHERE id = $1", [reviewOwnerStaffId]);
            const managerId = staffRes.rows[0]?.manager_id || null;

            // 3. Create review record
            await client.query(`
                INSERT INTO lead_reviews (candidate_id, staff_id, manager_id, closing_date, notes, screenshot_url, status)
                VALUES ($1, $2, $3, $4, $5, $6, 'pending')
            `, [id, reviewOwnerStaffId, managerId, closingDate, notes, screenshotUrl]);

            // 4. Update lead status
            await client.query("UPDATE candidates SET review_status = 'pending', lead_status = 'review_pending', review_requested_at = NOW() WHERE id = $1", [id]);

            // 5. Log activity
            await client.query(`
                INSERT INTO lead_activity_log (candidate_id, staff_id, action, notes)
                VALUES ($1, $2, 'review_submitted', $3)
            `, [id, actorStaffId, `Lead submitted for review. Notes: ${notes}`]);

            log({
                module: 'lead-review',
                message: 'review.submitted',
                meta: { candidateId: id, actorStaffId, reviewOwnerStaffId, actorRole }
            });
            res.json({ success: true });
        });
    } catch (error: any) {
        log({ level: 'error', module: 'lead-review', message: 'review.submit_failed', meta: { error: error.message } });
        res.status(500).json({ error: 'Internal server error' });
    }
});

const getInboxReviews = async (req: any, res: any, forcedStatus?: string) => {
    const { managerId } = req.params;
    const actor = (req as any).user || {};
    const actorRole = String(actor.role || '').toLowerCase();
    const actorStaffId = String(actor.staffId || '').trim();
    const status = String(forcedStatus || req.query?.status || 'pending').trim().toLowerCase();
    const normalizedStatus = status === 'returned' ? 'returned_for_call_again' : status;

    if (!actorStaffId) return res.status(401).json({ error: 'Unauthorized' });
    if (actorRole === 'manager' && managerId !== actorStaffId) {
        return res.status(403).json({ error: 'Managers can only view their own pending reviews' });
    }
    if (actorRole === 'staff') {
        return res.status(403).json({ error: 'Only managers and admins can view pending reviews' });
    }

    try {
        const reviews = await withDb(async (client) => {
            const whereStatus = normalizedStatus === 'all' ? '' : 'AND r.status = $2';
            const params = normalizedStatus === 'all' ? [managerId] : [managerId, normalizedStatus];
            const result = await client.query(`
                SELECT r.*, c.name as lead_name, s.name as staff_name
                FROM lead_reviews r
                JOIN candidates c ON r.candidate_id = c.id
                JOIN staff_members s ON r.staff_id = s.id
                WHERE r.manager_id = $1 ${whereStatus}
                ORDER BY r.updated_at DESC, r.created_at DESC
            `, params);
            return result.rows;
        });
        res.json(reviews);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
};

// Get reviews for review inbox sections (pending + history)
router.get('/inbox/:managerId', async (req, res) => {
    return getInboxReviews(req, res);
});

// Backward compatible route
router.get('/pending/:managerId', async (req, res) => {
    return getInboxReviews(req, res, 'pending');
});

// Approve or reject a review
router.post('/:reviewId/decision', async (req, res) => {
    const { reviewId } = req.params;
    const actor = (req as any).user || {};
    const actorRole = String(actor.role || '').toLowerCase();
    const actorStaffId = String(actor.staffId || req.body?.managerId || '').trim();
    const status = String(req.body?.status || req.body?.decision || '').trim().toLowerCase();
    const normalizedStatus = status === 'returned' ? 'returned_for_call_again' : status;
    const feedback = String(req.body?.feedback || '').trim();
    const reasonCode = String(req.body?.reasonCode || req.body?.reason_code || '').trim();

    if (!actorStaffId) return res.status(401).json({ error: 'Unauthorized' });
    if (!['manager', 'admin'].includes(actorRole)) return res.status(403).json({ error: 'Only managers/admins can decide reviews' });
    if (!DECISION_STATUSES.includes(normalizedStatus as any)) return res.status(400).json({ error: 'Invalid decision status' });
    if (['rejected', 'returned_for_call_again'].includes(normalizedStatus) && !reasonCode) {
        return res.status(400).json({ error: 'Reason code is required for rejection/return decisions' });
    }

    try {
        await withDb(async (client) => {
            const reviewRes = await client.query("SELECT * FROM lead_reviews WHERE id = $1", [reviewId]);
            if (reviewRes.rows.length === 0) return res.status(404).json({ error: 'Review not found' });
            
            const review = reviewRes.rows[0];
            const candidateId = review.candidate_id;

            // 1. Update review record
            await client.query(`
                UPDATE lead_reviews 
                SET status = $1, manager_feedback = $2, updated_at = NOW()
                WHERE id = $3
            `, [normalizedStatus, feedback, reviewId]);

            // 2. Update lead status
            const newLeadStatus = normalizedStatus === 'approved'
                ? 'closed'
                : normalizedStatus === 'rejected'
                    ? 'rejected'
                    : 'assigned';
            const newReviewStatus = normalizedStatus;
            await client.query(`
                UPDATE candidates 
                SET lead_status = $1, review_status = $2, closed_at = CASE WHEN $1 = 'closed' THEN NOW() ELSE closed_at END
                WHERE id = $3
            `, [newLeadStatus, newReviewStatus, candidateId]);

            // 3. Log activity
            await client.query(`
                INSERT INTO lead_activity_log (candidate_id, staff_id, action, notes)
                VALUES ($1, $2, $3, $4)
            `, [
                candidateId,
                actorStaffId,
                `review_${normalizedStatus}`,
                `Review ${normalizedStatus} by manager. Reason: ${reasonCode || 'n/a'}. Feedback: ${feedback || 'n/a'}`
            ]);

            log({ module: 'lead-review', message: `review.${normalizedStatus}`, meta: { reviewId, candidateId, reasonCode } });
            res.json({ success: true });
        });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

export default router;
