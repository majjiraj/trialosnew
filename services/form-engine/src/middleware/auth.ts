import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';

export interface JwtPayload {
  sub: string;
  org_id: string;
  roles: string[];
  is_platform_admin?: boolean;
}

export interface AuthRequest extends Request {
  user?: JwtPayload;
  orgId?: string;
}

export function authenticate(req: AuthRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    const payload = jwt.verify(token, config.jwtSecret) as JwtPayload;
    req.user = payload;
    req.orgId = payload.org_id;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}
