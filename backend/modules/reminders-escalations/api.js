const { ReminderServiceFacade } = require('./service');

const buildRemindersRouter = ({ legacyScheduleHandler, legacyQueueHandler }) => {
  const facade = new ReminderServiceFacade({ legacyScheduleHandler, legacyQueueHandler });

  return {
    schedule: (req, res) => facade.schedule(req, res),
    processQueue: (req, res) => facade.processQueue(req, res),
  };
};

module.exports = { buildRemindersRouter };
