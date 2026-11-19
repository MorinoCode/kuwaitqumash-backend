import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import logger from '../utils/logger.js';

let io;

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

export const getIO = () => {
  if (!io) {
    throw new Error('Socket.io not initialized!');
  }
  return io;
};
