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
  const token = authHeader?.startsWith('Bearer ')
    ? authHeader.slice(7)
    : req.cookies?.trialo_token;

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const payload = jwt.verify(token, config.jwtSecret) as JwtPayload;
    req.user = payload;
    req.orgId = payload.org_id;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

export function requireScope(scope: string) {
  const ROLE_SCOPES: Record<string, string[]> = {
    platform_admin: ['apps:read', 'apps:write', 'apps:publish', 'apps:install', 'workflows:start', 'tasks:complete', 'esig:create'],
    tenant_admin:   ['apps:read', 'apps:write', 'apps:install', 'workflows:start', 'tasks:complete', 'esig:create'],
    sponsor_admin:  ['apps:read', 'apps:write', 'apps:install', 'workflows:start', 'tasks:complete', 'esig:create'],
    cro_data_manager: ['apps:read', 'workflows:start', 'tasks:complete'],
    site_pi:        ['apps:read', 'workflows:start', 'tasks:complete', 'esig:create'],
    site_crc:       ['apps:read', 'workflows:start', 'tasks:complete'],
    medical_monitor:['apps:read', 'tasks:complete', 'esig:create'],
    biostatistician:['apps:read', 'tasks:complete'],
    analyst:        ['apps:read'],
  };

  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    const { roles, is_platform_admin } = req.user;
    if (is_platform_admin) return next();
    const hasScope = (roles || []).some(role => ROLE_SCOPES[role]?.includes(scope));
    if (!hasScope) return res.status(403).json({ error: `Missing scope: ${scope}` });
    next();
  };
}
