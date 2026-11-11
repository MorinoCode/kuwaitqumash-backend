import crypto from 'crypto';

const HEADER = 'x-request-id';

export const requestId = (req, res, next) => {
  const incoming = req.headers[HEADER];
  const id = typeof incoming === 'string' && incoming.trim()
    ? incoming.trim()
    : crypto.randomUUID();
  req.requestId = id;
  res.setHeader(HEADER, id);
  next();
};
