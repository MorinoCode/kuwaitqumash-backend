import { describe, it } from 'node:test';
import assert from 'node:assert';
import logger from '../src/utils/logger.js';

describe('logger', () => {
  it('info does not throw', () => {
    assert.doesNotThrow(() => logger.info('test message', { foo: 1 }));
  });

  it('warn does not throw', () => {
    assert.doesNotThrow(() => logger.warn('test warn', { bar: 2 }));
  });

  it('error does not throw', () => {
    assert.doesNotThrow(() => logger.error('test error', { err: 'x' }));
  });
});
