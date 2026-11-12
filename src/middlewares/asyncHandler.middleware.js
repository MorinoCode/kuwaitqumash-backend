export const asyncHandler = (fn) => {
  return (req, res, next) => {
    try {
      Promise.resolve(fn(req, res, next)).catch(next);
    } catch (error) {
      // A handler that throws before returning its promise must reach the
      // error middleware too, otherwise the request hangs.
      next(error);
    }
  };
};

export default asyncHandler;
