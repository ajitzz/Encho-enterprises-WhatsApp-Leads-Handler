import app from '../server.js';

export default (req: any, res: any) => {
  if (!app || typeof app !== 'function') {
    console.error('Express app not found in server export.');
    return res.status(500).json({ error: 'Internal Server Error: App not found' });
  }
  return app(req, res);
};
