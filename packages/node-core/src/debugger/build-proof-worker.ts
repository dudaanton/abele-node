import { parentPort, workerData } from 'node:worker_threads'
import { isDeepStrictEqual } from 'node:util'
import { readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, sep } from 'node:path'
import ts from 'typescript'
import { mappedSourcePath } from './source-map-paths.js'

async function prove() {
  const { root, source, map } = workerData as { root: string; source: string; map: string }
  const inside = (path: string) => {
    const rel = relative(root, path)
    return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)
  }
  const config = ts.findConfigFile(dirname(source), ts.sys.fileExists)
  if (!config || !inside(realpathSync(config))) return proveStandalone(source, map)
  const file = ts.readConfigFile(config, ts.sys.readFile)
  if (file.error) return false
  const parsed = ts.parseJsonConfigFileContent(file.config, ts.sys, dirname(config))
  if (parsed.errors.length || parsed.fileNames.length > 4096) return false
  const options = {
    ...parsed.options,
    noEmit: false,
    noEmitOnError: false,
    incremental: false,
    composite: false,
  }
  const program = ts.createProgram(parsed.fileNames, options)
  let jsMatches = false
  let emittedMap: string | undefined
  const expectedMap = JSON.parse(readFileSync(map, 'utf8'))
  const expectedJs = readFileSync(map.slice(0, -4), 'utf8')
  program.emit(undefined, (path, text) => {
    if (path === map) emittedMap = text
    if (path === map.slice(0, -4)) jsMatches = text === expectedJs
  })
  if (!jsMatches || !emittedMap) return false
  const actualMap = JSON.parse(emittedMap)
  if (
    !Array.isArray(expectedMap.sources) ||
    !Array.isArray(actualMap.sources) ||
    expectedMap.sources.length !== actualMap.sources.length
  )
    return false
  for (let i = 0; i < expectedMap.sources.length; i++) {
    const expected = await mappedSourcePath(
      root,
      map,
      expectedMap.sourceRoot ?? '',
      expectedMap.sources[i]
    )
    const actual = await mappedSourcePath(
      root,
      map,
      actualMap.sourceRoot ?? '',
      actualMap.sources[i]
    )
    if (!expected || expected !== actual) return false
  }
  // URL spelling and checkout prefixes are incidental; mappings and emitted
  // bytes still have to match the compiler exactly.
  const { sources: _expectedSources, sourceRoot: _expectedRoot, ...expected } = expectedMap
  const { sources: _actualSources, sourceRoot: _actualRoot, ...actual } = actualMap
  return isDeepStrictEqual(expected, actual)
}

/** Standalone compiler APIs do not leave a tsconfig. Prove their output with
 * bounded compiler recipes, never by assuming one of those recipes was used.
 * Relocating a map and changing its final URL does not change its mappings. */
async function proveStandalone(source: string, mapPath: string) {
  const expectedMap = JSON.parse(readFileSync(mapPath, 'utf8'))
  if (
    !Array.isArray(expectedMap.sources) ||
    expectedMap.sources.length !== 1 ||
    typeof expectedMap.sources[0] !== 'string'
  )
    return false
  if (
    (await mappedSourcePath(
      workerData.root,
      mapPath,
      expectedMap.sourceRoot ?? '',
      expectedMap.sources[0]
    )) !== realpathSync(source)
  )
    return false
  const text = readFileSync(source, 'utf8'),
    expectedJs = readFileSync(mapPath.slice(0, -4), 'utf8')
  // Only trailing map directives/blank lines are incidental. Internal whitespace
  // and line positions still have to match the compiler output exactly.
  const code = (text: string) =>
    text
      .replace(/(?:^|\r?\n)[\t ]*\/\/[#@][\t ]+sourceMappingURL=[^\r\n]*(?:\r?\n[\t ]*)*$/, '')
      .trimEnd()
  for (const module of [ts.ModuleKind.CommonJS, ts.ModuleKind.ESNext]) {
    for (const target of [ts.ScriptTarget.ES2022, ts.ScriptTarget.ESNext, ts.ScriptTarget.ES2015]) {
      const built = ts.transpileModule(text, {
        fileName: basename(source),
        compilerOptions: { module, target, sourceMap: true, sourceRoot: '' },
      })
      const actualMap = JSON.parse(built.sourceMapText!)
      if (
        code(built.outputText) === code(expectedJs) &&
        actualMap.version === expectedMap.version &&
        actualMap.mappings === expectedMap.mappings &&
        JSON.stringify(actualMap.names) === JSON.stringify(expectedMap.names)
      )
        return true
    }
  }
  return false
}
try {
  parentPort!.postMessage(await prove())
} catch {
  parentPort!.postMessage(false)
}
