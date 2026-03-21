export const log = ({ level = 'info', module = 'app', message = '', requestId = null, meta = {} } = {}) => {
  const payload = {
    timestamp: new Date().toISOString(),
    level,
    module,
    message,
    requestId,
    ...meta,
  };
  const line = JSON.stringify(payload);
  if (level === 'error') {
    console.error(line);
    return;
  }
  console.log(line);
};

export default { log };
