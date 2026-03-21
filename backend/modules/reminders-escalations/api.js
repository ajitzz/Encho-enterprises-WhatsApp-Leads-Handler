import { ReminderServiceFacade } from './service.js';

export const buildRemindersRouter = ({
  legacyScheduleHandler,
  legacyQueueHandler,
  legacyListDriverScheduledHandler,
  legacyDeleteScheduledHandler,
  legacyPatchScheduledHandler,
}) => {
  const facade = new ReminderServiceFacade({
    legacyScheduleHandler,
    legacyQueueHandler,
    legacyListDriverScheduledHandler,
    legacyDeleteScheduledHandler,
    legacyPatchScheduledHandler,
  });

  return {
    schedule: (req, res) => facade.schedule(req, res),
    processQueue: (req, res) => facade.processQueue(req, res),
    listDriverScheduled: (req, res) => facade.listDriverScheduled(req, res),
    deleteScheduled: (req, res) => facade.deleteScheduled(req, res),
    patchScheduled: (req, res) => facade.patchScheduled(req, res),
  };
};

export default { buildRemindersRouter };
