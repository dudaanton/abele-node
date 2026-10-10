import { expect, it } from 'vitest'
import { RepositoryObjectCache } from '../packages/node-core/src/object-cache.js'
it('bounds cache bytes and entries, evicts LRU, skips large objects and copies buffers', () => {
  const cache = new RepositoryObjectCache(6, 2, 4)
  const original = Buffer.from('abc')
  cache.set('a', original)
  original.fill(0)
  cache.set('b', Buffer.from('def'))
  const hit = cache.get('a')!
  expect(hit.toString()).toBe('abc')
  hit.fill(0)
  cache.set('c', Buffer.from('ghi'))
  expect(cache.get('b')).toBeUndefined()
  expect(cache.get('a')!.toString()).toBe('abc')
  cache.set('large', Buffer.from('12345'))
  expect(cache.get('large')).toBeUndefined()
  cache.set('d', Buffer.alloc(0))
  expect(cache.get('c')).toBeUndefined()
  cache.clear()
  expect(cache.get('a')).toBeUndefined()
})
