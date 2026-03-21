require('tsx/cjs');

const server = require('../server.ts');


const ensureReqResShape = (req, res) => {
  if (!req || typeof req !== 'object') return;
  if (typeof req.unpipe !== 'function') req.unpipe = () => req;
  if (typeof req.resume !== 'function') req.resume = () => req;
  if (typeof req.pipe !== 'function') req.pipe = () => req;
  if (typeof req.on !== 'function') req.on = () => req;
  if (typeof req.listeners !== 'function') req.listeners = () => [];
  if (!req.headers || typeof req.headers !== 'object') req.headers = {};

  if (res && typeof res === 'object' && !res.req) {
    res.req = req;
  }
};

const app =
  (server && (server.default || server.app)) ||
  (typeof server === 'function' ? server : null);

module.exports = (req, res) => {
  ensureReqResShape(req, res);
  if (typeof app !== 'function') {
    const exportedKeys = server && typeof server === 'object' ? Object.keys(server) : [];
    console.error('Express app not found in server export. Keys:', exportedKeys);
    throw new Error('Express app not found or invalid in server export');
  }

  return app(req, res);
};
