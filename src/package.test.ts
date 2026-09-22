import { readFileSync } from 'fs'
import { join } from 'path'

// The published entry is a contract with bundlers, TypeScript's node16
// resolution, and Node itself.  main/types alone are the legacy fallback;
// without exports, deep paths such as graferse/dist/graph stay importable
// and modern resolvers have no conditions to pick from.
describe('package entry points', () => {
    const pkg = JSON.parse(
        readFileSync(join(process.cwd(), 'package.json'), 'utf8'))

    test('exports the package root to the built entry', () => {
        expect(pkg.exports).toEqual({
            '.': {
                types: './dist/index.d.ts',
                default: './dist/index.js',
            },
            './package.json': './package.json',
        })
    })

    test('legacy main and types agree with exports', () => {
        expect(pkg.main).toBe('dist/index.js')
        expect(pkg.types).toBe('dist/index.d.ts')
        expect(pkg.exports['.'].default).toBe(`./${pkg.main}`)
        expect(pkg.exports['.'].types).toBe(`./${pkg.types}`)
    })

    test('the files allowlist ships dist, where exports points', () => {
        expect(pkg.files).toContain('dist/**/*')
        expect(pkg.exports['.'].default.startsWith('./dist/')).toBe(true)
        expect(pkg.exports['.'].types.startsWith('./dist/')).toBe(true)
    })
})
