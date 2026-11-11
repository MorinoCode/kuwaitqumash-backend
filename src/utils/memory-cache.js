const cache = new Map();
const MAX_CACHE_SIZE = 1000;

export const memoryCacheGet = (key) => {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.value;
};

export const memoryCacheSet = (key, value, ttlSeconds = 60) => {
  if (cache.size >= MAX_CACHE_SIZE) {

    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }
  cache.set(key, {
    value,
    expiresAt: Date.now() + (ttlSeconds * 1000),
  });
};

export const memoryCacheDelete = (key) => {
  cache.delete(key);
};

export const memoryCacheDeletePattern = (pattern) => {

  const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
  for (const key of cache.keys()) {
    if (regex.test(key)) {
      cache.delete(key);
    }
  }
};
