import crypto from 'crypto';

const HEADER = 'x-request-id';

/**
 * Assigns a correlation ID to each request. Uses X-Request-Id from client if present,
 * otherwise generates a UUID. Attaches to req.requestId and sets response header.
 */
export const requestId = (req, res, next) => {
  const incoming = req.headers[HEADER];
  const id = typeof incoming === 'string' && incoming.trim()
    ? incoming.trim()
    : crypto.randomUUID();
  req.requestId = id;
  res.setHeader(HEADER, id);
  next();
};
