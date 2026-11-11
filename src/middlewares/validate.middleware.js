/**
 * Validation middleware using Zod.
 * Use after body-parser (and after multer for multipart routes).
 * On success: req.body (or req[source]) is replaced with parsed value.
 * On failure: responds 400 with { message, errors } and does not call next.
 *
 * @param {import('zod').ZodSchema} schema - Zod schema to validate against
 * @param {'body'|'query'|'params'} [source='body'] - Where to read from and write to
 */
export function validate(schema, source = 'body') {
  return (req, res, next) => {
    const raw = req[source];
    const result = schema.safeParse(raw);

    if (result.success) {
      req[source] = result.data;
      return next();
    }

    const err = result.error;
    const messages = err.errors.map((e) => {
      const path = e.path.length ? e.path.join('.') : 'body';
      return path ? `${path}: ${e.message}` : e.message;
    });
    const message = messages[0] || 'Validation failed.';

    return res.status(400).json({
      success: false,
      message,
      errors: err.errors,
    });
  };
}
