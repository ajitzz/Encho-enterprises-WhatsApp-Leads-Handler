import * as express from 'express';

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        staffId: string;
        role: string;
        name: string;
      };
      requestId?: string;
    }
  }
}
