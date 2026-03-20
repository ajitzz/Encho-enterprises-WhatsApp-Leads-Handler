import { app } from '../server';

export default (req: any, res: any) => {
  if (typeof app !== 'function') {
    throw new TypeError('Invalid server export: expected an Express app function.');
  }
  return app(req, res);
};
