import * as express from 'express';

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        staffId: string;
        role: string;
        name: string;
        email: string;
        isShadowMode?: boolean;
        originalAdminStaffId?: string;
        originalAdminRole?: string;
        originalAdminName?: string;
      };
      requestId?: string;
    }
  }
}
