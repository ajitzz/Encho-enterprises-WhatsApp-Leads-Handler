import { log } from '../../shared/infra/logger.js';
import { buildLatencyTracker, parsePositiveInt } from '../../shared/infra/perf.js';

const REMINDER_SCHEDULE_WARN_MS = parsePositiveInt(process.env.REMINDER_SCHEDULE_WARN_MS, 800);
const REMINDER_QUEUE_WARN_MS = parsePositiveInt(process.env.REMINDER_QUEUE_WARN_MS, 2500);

export class ReminderServiceFacade {
  constructor({
    legacyScheduleHandler,
    legacyQueueHandler,
    legacyListDriverScheduledHandler,
    legacyDeleteScheduledHandler,
    legacyPatchScheduledHandler,
  }) {
    this.legacyScheduleHandler = legacyScheduleHandler;
    this.legacyQueueHandler = legacyQueueHandler;
    this.legacyListDriverScheduledHandler = legacyListDriverScheduledHandler;
    this.legacyDeleteScheduledHandler = legacyDeleteScheduledHandler;
    this.legacyPatchScheduledHandler = legacyPatchScheduledHandler;
  }

  async schedule(req, res) {
    log({ module: 'reminders-escalations', message: 'reminders.schedule.module_path.selected', requestId: req?.requestId || null });
    const latency = buildLatencyTracker({
      module: 'reminders-escalations',
      requestId: req?.requestId || null,
      operation: 'reminders_schedule',
      warnThresholdMs: REMINDER_SCHEDULE_WARN_MS,
    });

    const result = await this.legacyScheduleHandler(req, res);
    latency.end({ path: 'module-facade' });
    return result;
  }

  async processQueue(req, res) {
    log({ module: 'reminders-escalations', message: 'reminders.queue.module_path.selected', requestId: req?.requestId || null });
    const latency = buildLatencyTracker({
      module: 'reminders-escalations',
      requestId: req?.requestId || null,
      operation: 'reminders_queue_tick',
      warnThresholdMs: REMINDER_QUEUE_WARN_MS,
    });

    const result = await this.legacyQueueHandler(req, res);
    latency.end({ path: 'module-facade' });
    return result;
  }

  async listDriverScheduled(req, res) {
    log({ module: 'reminders-escalations', message: 'reminders.list.module_path.selected', requestId: req?.requestId || null });
    const latency = buildLatencyTracker({
      module: 'reminders-escalations',
      requestId: req?.requestId || null,
      operation: 'reminders_list',
      warnThresholdMs: REMINDER_SCHEDULE_WARN_MS,
    });

    const result = await this.legacyListDriverScheduledHandler(req, res);
    latency.end({ path: 'module-facade' });
    return result;
  }

  async deleteScheduled(req, res) {
    log({ module: 'reminders-escalations', message: 'reminders.delete.module_path.selected', requestId: req?.requestId || null });
    const latency = buildLatencyTracker({
      module: 'reminders-escalations',
      requestId: req?.requestId || null,
      operation: 'reminders_delete',
      warnThresholdMs: REMINDER_SCHEDULE_WARN_MS,
    });

    const result = await this.legacyDeleteScheduledHandler(req, res);
    latency.end({ path: 'module-facade' });
    return result;
  }

  async patchScheduled(req, res) {
    log({ module: 'reminders-escalations', message: 'reminders.patch.module_path.selected', requestId: req?.requestId || null });
    const latency = buildLatencyTracker({
      module: 'reminders-escalations',
      requestId: req?.requestId || null,
      operation: 'reminders_patch',
      warnThresholdMs: REMINDER_SCHEDULE_WARN_MS,
    });

    const result = await this.legacyPatchScheduledHandler(req, res);
    latency.end({ path: 'module-facade' });
    return result;
  }
}

export default { ReminderServiceFacade };
