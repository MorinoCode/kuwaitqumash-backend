/**
 * In-memory cache for when Redis is not available.
 * Simple TTL-based cache for dashboard and heavy queries.
 */

const cache = new Map();
const MAX_CACHE_SIZE = 1000; // Cap to prevent memory leaks

/**
 * Get value from cache. Returns null if expired or not found.
 */
export const memoryCacheGet = (key) => {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.value;
};

/**
 * Set value in cache with optional TTL in seconds.
 */
export const memoryCacheSet = (key, value, ttlSeconds = 60) => {
  if (cache.size >= MAX_CACHE_SIZE) {
    // Evict the oldest key to prevent memory leaks
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }
  cache.set(key, {
    value,
    expiresAt: Date.now() + (ttlSeconds * 1000),
  });
};

/**
 * Delete a key from cache.
 */
export const memoryCacheDelete = (key) => {
  cache.delete(key);
};

/**
 * Delete keys matching a pattern.
 */
export const memoryCacheDeletePattern = (pattern) => {
  // Convert Redis wildcard '*' to regex '.*'
  const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
  for (const key of cache.keys()) {
    if (regex.test(key)) {
      cache.delete(key);
    }
  }
};
