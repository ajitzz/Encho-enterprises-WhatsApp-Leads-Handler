const server = require('../server');
let app = server.default || server.app;

if (!app && typeof server === 'function') {
  app = server;
}

export default (req: any, res: any) => {
  if (!app || typeof app !== 'function') {
    console.error('Express app not found in server export. Keys:', Object.keys(server));
    throw new Error('Express app not found or invalid in server export');
  }
  return app(req, res);
};
