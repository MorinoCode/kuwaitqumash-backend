import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import User from '../domains/auth/user.model.js';
import { cacheGet, cacheSet, cacheDelete } from '../config/redis.js';
import logger from '../utils/logger.js';

const getJwtRevocationKey = (decoded, rawToken) =>
  `revoked:jwt:${decoded?.jti || crypto.createHash('sha256').update(String(rawToken)).digest('hex')}`;

const getAuthUserCacheKey = (schema, userId) => `auth:user:${schema}:${userId}`;

const getAuthUserCacheTtl = () => {
  if (process.env.AUTH_USER_CACHE_TTL_SECONDS !== undefined) {
    return Math.max(0, Number(process.env.AUTH_USER_CACHE_TTL_SECONDS) || 0);
  }
  return process.env.NODE_ENV === 'test' ? 0 : 45;
};

export const invalidateAuthUserCache = async (schema, userId) => {
  if (!schema || !userId) return;
  await cacheDelete(getAuthUserCacheKey(schema, userId));
};

export const protect = async (req, res, next) => {
  try {

    if (!req.tenant) {
        return res.status(500).json({ message: 'System Error: Tenant context not set before authentication.' });
    }

    let token;

    if (req.cookies && req.cookies.token) {
      token = req.cookies.token;
    } else if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      return res.status(401).json({ message: 'Not authorized, no token provided.' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });

    // A token is only valid for the store it was issued for: the schema is chosen
    // from the x-tenant-id header, so without this check a token from any store
    // would authenticate as the same numeric user id inside the requested store.
    if (!decoded.tenant || decoded.tenant !== req.tenant.slug) {
      return res.status(401).json({ message: 'Not authorized for this store.' });
    }

    const cacheTtl = getAuthUserCacheTtl();
    const userCacheKey = getAuthUserCacheKey(req.tenant.db_schema, decoded.id);

    const [revoked, cachedUser] = await Promise.all([
      cacheGet(getJwtRevocationKey(decoded, token)),
      cacheTtl > 0 ? cacheGet(userCacheKey) : Promise.resolve(null),
    ]);

    if (revoked) {
      return res.status(401).json({ message: 'Session has been revoked.' });
    }

    let user = cachedUser;
    if (!user) {
      const dbUser = await User.schema(req.tenant.db_schema).findByPk(decoded.id, {
        attributes: { exclude: ['password'] }
      });
      if (dbUser) {
        user = typeof dbUser.toJSON === 'function' ? dbUser.toJSON() : dbUser;
        if (cacheTtl > 0) {
          await cacheSet(userCacheKey, user, cacheTtl);
        }
      }
    }

    if (!user) {
      return res.status(401).json({ message: 'User not found or access revoked.' });
    }

    if (!user.is_active) {
      return res.status(403).json({ message: 'User account is inactive.' });
    }

    const tokenVersion = decoded.tv ?? 0;
    const currentVersion = user.token_version ?? 0;
    if (tokenVersion !== currentVersion) {
      return res.status(401).json({ message: 'Session expired or revoked. Please log in again.' });
    }

    req.user = user;
    next();
  } catch (error) {
    logger.error('Auth middleware error', { component: 'auth.middleware', error: error?.message });
    res.status(401).json({ message: 'Not authorized, token failed.' });
  }
};

export const restrictTo = (...allowedRoles) => {
  return (req, res, next) => {

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        message: 'Access denied. You do not have permission to perform this action.'
      });
    }
    next();
  };
};
