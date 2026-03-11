const { log } = require('../../shared/infra/logger');

class ReminderServiceFacade {
  constructor({ legacyScheduleHandler, legacyQueueHandler }) {
    this.legacyScheduleHandler = legacyScheduleHandler;
    this.legacyQueueHandler = legacyQueueHandler;
  }

  async schedule(req, res) {
    log({ module: 'reminders-escalations', message: 'reminders.schedule.module_path.selected', requestId: req?.requestId || null });
    return this.legacyScheduleHandler(req, res);
  }

  async processQueue(req, res) {
    log({ module: 'reminders-escalations', message: 'reminders.queue.module_path.selected', requestId: req?.requestId || null });
    return this.legacyQueueHandler(req, res);
  }
}

module.exports = { ReminderServiceFacade };
