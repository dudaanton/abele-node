import { parentPort, workerData } from 'node:worker_threads'
import { readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import ts from 'typescript'

function prove() {
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
  let jsMatches = false,
    mapMatches = false
  const expectedMap = readFileSync(map, 'utf8')
  const expectedJs = readFileSync(map.slice(0, -4), 'utf8')
  program.emit(undefined, (path, text) => {
    if (path === map) mapMatches = text === expectedMap
    if (path === map.slice(0, -4)) jsMatches = text === expectedJs
  })
  return jsMatches && mapMatches
}

/** Standalone compiler APIs do not leave a tsconfig. Prove their output with
 * bounded compiler recipes, never by assuming one of those recipes was used.
 * Relocating a map and changing its final URL does not change its mappings. */
function proveStandalone(source: string, mapPath: string) {
  const expectedMap = JSON.parse(readFileSync(mapPath, 'utf8'))
  if (
    !Array.isArray(expectedMap.sources) ||
    expectedMap.sources.length !== 1 ||
    typeof expectedMap.sources[0] !== 'string'
  )
    return false
  if (
    realpathSync(
      resolve(dirname(mapPath), expectedMap.sourceRoot ?? '', expectedMap.sources[0])
    ) !== realpathSync(source)
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
  parentPort!.postMessage(prove())
} catch {
  parentPort!.postMessage(false)
}
