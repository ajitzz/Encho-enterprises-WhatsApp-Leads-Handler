import { log } from '../../shared/infra/logger.js';

export class LeadAssignmentService {
  constructor({ withDb, executeWithRetry }) {
    this.withDb = withDb;
    this.executeWithRetry = executeWithRetry;
  }

  async assignLeadAutomatically({ candidateId, requestId }) {
    return this.withDb(async (client) => {
      return this.executeWithRetry(client, async () => {
        // 1. Check if auto-assignment is enabled
        const configRes = await client.query("SELECT value FROM system_settings WHERE key = 'config'");
        const config = configRes.rows[0]?.value || {};

        if (!config.auto_assignment_enabled) {
          log({ module: 'lead-assignment', message: 'auto_assignment.disabled', requestId });
          return null;
        }

        // 2. Find available staff members (On Duty)
        // We exclude admins from auto-assignment usually, or include them if they want.
        // For now, let's include all staff who are 'is_active'
        const staffRes = await client.query(
          "SELECT id, name FROM staff_members WHERE is_active = TRUE ORDER BY last_assigned_at ASC NULLS FIRST LIMIT 1"
        );

        if (staffRes.rows.length === 0) {
          log({ module: 'lead-assignment', message: 'auto_assignment.no_active_staff', requestId });
          return null;
        }

        const staff = staffRes.rows[0];

        // 3. Assign the lead
        await client.query(
          "UPDATE candidates SET assigned_to = $1, lead_status = 'claimed' WHERE id = $2",
          [staff.id, candidateId]
        );

        // 4. Update staff last_assigned_at for Round Robin
        await client.query(
          "UPDATE staff_members SET last_assigned_at = NOW() WHERE id = $1",
          [staff.id]
        );

        // 5. Log activity
        await client.query(
          "INSERT INTO lead_activity_log (candidate_id, staff_id, action, notes) VALUES ($1, $2, $3, $4)",
          [candidateId, staff.id, 'auto_assigned', `Lead automatically assigned to ${staff.name} via Round Robin.`]
        );

        log({ 
          module: 'lead-assignment', 
          message: 'auto_assignment.success', 
          requestId, 
          meta: { candidateId, staffId: staff.id, staffName: staff.name } 
        });

        return staff;
      });
    });
  }
}

export default { LeadAssignmentService };
