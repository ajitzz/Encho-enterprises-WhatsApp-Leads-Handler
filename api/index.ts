import app from '../server';

export default (req: any, res: any) => {
  if (!app || typeof app !== 'function') {
    // Fallback for CommonJS or named exports
    const serverModule: any = require('../server');
    const actualApp = serverModule.default || serverModule.app || (typeof serverModule === 'function' ? serverModule : null);
    
    if (!actualApp || typeof actualApp !== 'function') {
      console.error('Express app not found in server export. Keys:', Object.keys(serverModule));
      throw new Error('Express app not found or invalid in server export');
    }
    return actualApp(req, res);
  }
  return app(req, res);
};
