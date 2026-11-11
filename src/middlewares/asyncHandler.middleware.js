/**
 * Async Handler Middleware
 * Wraps async route handlers to catch errors and pass them to Express error handler
 * This ensures all async errors are properly caught and handled
 */
export const asyncHandler = (fn) => {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

export default asyncHandler;
