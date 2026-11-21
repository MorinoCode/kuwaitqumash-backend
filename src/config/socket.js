import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import Redis from 'ioredis';
import logger from '../utils/logger.js';
import { isRedisEnabled } from './redis.js';

let io;
let pubClient = null;
let subClient = null;

const attachOptionalRedisAdapter = async (ioInstance) => {
  if (!isRedisEnabled() || process.env.NODE_ENV === 'test') {
    return;
  }

  let createAdapter;
  try {
    ({ createAdapter } = await import('@socket.io/redis-adapter'));
  } catch {
    logger.debug('Socket.IO Redis adapter package not installed; running single-node adapter', {
      component: 'socket',
    });
    return;
  }

  try {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    pubClient = new Redis(redisUrl, { maxRetriesPerRequest: 3, lazyConnect: true });
    subClient = pubClient.duplicate();

    pubClient.on('error', (err) => {
      logger.warn('Socket.IO Redis pubClient error', {
        component: 'socket',
        error: err?.message,
      });
    });
    subClient.on('error', (err) => {
      logger.warn('Socket.IO Redis subClient error', {
        component: 'socket',
        error: err?.message,
      });
    });

    await Promise.all([pubClient.connect(), subClient.connect()]);
    ioInstance.adapter(createAdapter(pubClient, subClient));
    logger.info('Socket.IO Redis adapter attached for multi-node scaling', {
      component: 'socket',
    });
  } catch (error) {
    logger.warn('Socket.IO Redis adapter unavailable; continuing with in-memory adapter', {
      component: 'socket',
      error: error?.message,
    });
    await Promise.allSettled([
      pubClient?.quit?.(),
      subClient?.quit?.(),
    ]);
    pubClient = null;
    subClient = null;
  }
};

export const initSocket = (httpServer) => {
  const envOrigins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
    : [];

  const corsOrigins = [
    'http://localhost:5173',
    'http://localhost:3000',
    ...envOrigins,
  ];

  io = new Server(httpServer, {
    cors: {
      origin: corsOrigins,
      methods: ['GET', 'POST'],
      credentials: true
    }
  });

  void attachOptionalRedisAdapter(io);

  io.use((socket, next) => {
    if (io.engine.clientsCount > 1000) {
      return next(new Error('Connection limit exceeded'));
    }

    const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.split(' ')[1];

    if (!token) {
      return next(new Error('Authentication error: Token required'));
    }

    jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
      if (err || !decoded) {
        return next(new Error('Authentication error: Invalid token'));
      }
      socket.user = decoded;
      next();
    });
  });

  io.on('connection', (socket) => {
    logger.info('Socket client connected', { component: 'socket', socketId: socket.id });
    socket.on('disconnect', () => {
      logger.info('Socket client disconnected', { component: 'socket', socketId: socket.id });
    });
  });

  return io;
};

export const closeSocket = async () => {
  if (io) {
    await new Promise((resolve) => io.close(() => resolve()));
    io = null;
  }
  await Promise.allSettled([
    pubClient?.quit?.(),
    subClient?.quit?.(),
  ]);
  pubClient = null;
  subClient = null;
};

export const getIO = () => {
  if (!io) {
    throw new Error('Socket.io not initialized!');
  }
  return io;
};
