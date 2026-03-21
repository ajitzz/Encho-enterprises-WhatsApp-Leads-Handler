
import { Router } from 'express';
import { withDb } from '../../../server/db.js';
import { log } from '../../shared/infra/logger.js';

const router = Router();

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
            await client.query("UPDATE candidates SET review_status = 'pending', lead_status = 'review_pending' WHERE id = $1", [id]);

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

// Get pending reviews for a manager
router.get('/pending/:managerId', async (req, res) => {
    const { managerId } = req.params;
    const actor = (req as any).user || {};
    const actorRole = String(actor.role || '').toLowerCase();
    const actorStaffId = String(actor.staffId || '').trim();

    if (!actorStaffId) return res.status(401).json({ error: 'Unauthorized' });
    if (actorRole === 'manager' && managerId !== actorStaffId) {
        return res.status(403).json({ error: 'Managers can only view their own pending reviews' });
    }
    if (actorRole === 'staff') {
        return res.status(403).json({ error: 'Only managers and admins can view pending reviews' });
    }

    try {
        const reviews = await withDb(async (client) => {
            const result = await client.query(`
                SELECT r.*, c.name as candidate_name, s.name as staff_name
                FROM lead_reviews r
                JOIN candidates c ON r.candidate_id = c.id
                JOIN staff_members s ON r.staff_id = s.id
                WHERE r.manager_id = $1 AND r.status = 'pending'
                ORDER BY r.created_at DESC
            `, [managerId]);
            return result.rows;
        });
        res.json(reviews);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// Approve or reject a review
router.post('/:reviewId/decision', async (req, res) => {
    const { reviewId } = req.params;
    const actor = (req as any).user || {};
    const actorRole = String(actor.role || '').toLowerCase();
    const actorStaffId = String(actor.staffId || req.body?.managerId || '').trim();
    const status = String(req.body?.status || req.body?.decision || '').trim().toLowerCase(); // approved/rejected
    const feedback = String(req.body?.feedback || '').trim();

    if (!actorStaffId) return res.status(401).json({ error: 'Unauthorized' });
    if (!['manager', 'admin'].includes(actorRole)) return res.status(403).json({ error: 'Only managers/admins can decide reviews' });
    if (!['approved', 'rejected'].includes(status)) return res.status(400).json({ error: 'Invalid decision status' });

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
            `, [status, feedback, reviewId]);

            // 2. Update lead status
            const newLeadStatus = status === 'approved' ? 'closed' : 'assigned';
            const newReviewStatus = status;
            await client.query(`
                UPDATE candidates 
                SET lead_status = $1, review_status = $2 
                WHERE id = $3
            `, [newLeadStatus, newReviewStatus, candidateId]);

            // 3. Log activity
            await client.query(`
                INSERT INTO lead_activity_log (candidate_id, staff_id, action, notes)
                VALUES ($1, $2, $3, $4)
            `, [candidateId, actorStaffId, `review_${status}`, `Review ${status} by manager. Feedback: ${feedback}`]);

            log({ module: 'lead-review', message: `review.${status}`, meta: { reviewId, candidateId } });
            res.json({ success: true });
        });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

export default router;
