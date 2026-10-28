import { expect, it } from 'vitest'
import { inspectorPorts } from '../../packages/node-core/src/debugger/programs.js'
it('never probes unrelated application listeners', () => {
  expect(inspectorPorts(['node', '--inspect=9241', 'app.js'], [4340, 9241])).toEqual([9241])
  expect(inspectorPorts(['node', 'app.js'], [4340])).toEqual([])
  expect(inspectorPorts(['node', 'app.js', '--inspect=4340'], [4340])).toEqual([])
  expect(inspectorPorts(['node', '--inspect=0', 'app.js'], [4340, 49152])).toEqual([])
  expect(inspectorPorts(['node', 'app.js'], [4340, 9241], '--inspect=9241')).toEqual([9241])
})
