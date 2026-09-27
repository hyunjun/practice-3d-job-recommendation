import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { access, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { copyFixture } from '../fixtures/copy-fixture'

const privateRoot = fileURLToPath(new URL('../../.local/research/64-expansion/independent/copy-tests/', import.meta.url))
let directory: string | undefined

beforeEach(async () => {
  await mkdir(privateRoot, { recursive: true })
  directory = await mkdtemp(path.join(privateRoot, 'scratch-'))
})

afterEach(async () => {
  if (!directory) return
  await rm(directory, { recursive: true, force: true })
  await expect(access(directory)).rejects.toMatchObject({ code: 'ENOENT' })
  directory = undefined
})

describe('isolated fixture copies', () => {
  it('copies a renamed file byte for byte without sharing a writable inode', async () => {
    const source = path.join(directory!, 'vite.config.ts')
    const destination = path.join(directory!, 'vite.original.config.ts')
    const original = 'export default { label: "가상 café 🌏" }\r\n'
    await writeFile(source, original)

    await copyFixture(source, destination)

    expect(await readFile(destination)).toEqual(Buffer.from(original))
    const sourceStat = await lstat(source)
    const copyStat = await lstat(destination)
    expect(copyStat.isFile()).toBe(true)
    expect(copyStat.ino).not.toBe(sourceStat.ino)
    expect(sourceStat.nlink).toBe(1)
    expect(copyStat.nlink).toBe(1)

    await writeFile(destination, 'export default { runtimeOnly: true }\n')
    expect(await readFile(source, 'utf8')).toBe(original)
    await writeFile(source, 'export default { sourceOnly: true }\n')
    expect(await readFile(destination, 'utf8')).toBe('export default { runtimeOnly: true }\n')
    await copyFixture(source, destination)
    expect(await readFile(destination, 'utf8')).toBe('export default { sourceOnly: true }\n')
  })

  it('copies nested build bytes and empty directories, and permits independent cleanup', async () => {
    const source = path.join(directory!, 'frozen-build')
    const destination = path.join(directory!, 'runtime-build')
    await mkdir(path.join(source, 'dist/assets'), { recursive: true })
    await mkdir(path.join(source, 'dist/empty'))
    await mkdir(path.join(source, 'dist-server'))
    await writeFile(path.join(source, 'dist/index.html'), '<script src="/assets/app.js"></script>\n')
    await writeFile(path.join(source, 'dist/assets/app.js'), 'export const version = "synthetic64"\n')
    await writeFile(path.join(source, 'dist/assets/binary.dat'), Buffer.from([0, 255, 13, 10, 127, 128]))
    await writeFile(path.join(source, 'dist-server/index.mjs'), 'export const server = "synthetic64"\n')

    await copyFixture(source, destination)

    expect((await readdir(destination)).sort()).toEqual(['dist', 'dist-server'])
    expect(await readdir(path.join(destination, 'dist/empty'))).toEqual([])
    expect(await readFile(path.join(destination, 'dist/index.html'), 'utf8')).toBe('<script src="/assets/app.js"></script>\n')
    expect(await readFile(path.join(destination, 'dist/assets/app.js'), 'utf8')).toBe('export const version = "synthetic64"\n')
    expect(await readFile(path.join(destination, 'dist/assets/binary.dat'))).toEqual(Buffer.from([0, 255, 13, 10, 127, 128]))
    expect(await readFile(path.join(destination, 'dist-server/index.mjs'), 'utf8')).toBe('export const server = "synthetic64"\n')

    await writeFile(path.join(destination, 'dist/assets/binary.dat'), Buffer.from([64, 65]))
    expect(await readFile(path.join(source, 'dist/assets/binary.dat'))).toEqual(Buffer.from([0, 255, 13, 10, 127, 128]))
    await writeFile(path.join(source, 'dist-server/index.mjs'), 'export const server = "changed-source"\n')
    expect(await readFile(path.join(destination, 'dist-server/index.mjs'), 'utf8')).toBe('export const server = "synthetic64"\n')
    await rm(destination, { recursive: true })
    await expect(access(destination)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(path.join(source, 'dist/index.html'), 'utf8')).toBe('<script src="/assets/app.js"></script>\n')
    expect(await readFile(path.join(source, 'dist-server/index.mjs'), 'utf8')).toBe('export const server = "changed-source"\n')
  })

  it('merges into an existing runtime directory without nesting or deleting unrelated files', async () => {
    const source = path.join(directory!, 'source files')
    const destination = path.join(directory!, 'runtime files')
    await mkdir(path.join(source, 'nested'), { recursive: true })
    await mkdir(path.join(destination, 'nested'), { recursive: true })
    await writeFile(path.join(source, 'nested/main.js'), 'export const version = 64\n')
    await writeFile(path.join(destination, 'nested/main.js'), 'outdated longer contents must be replaced\n')
    await writeFile(path.join(destination, 'runtime-only.txt'), 'private fixture artifact\n')

    await copyFixture(source, destination)

    expect((await readdir(destination)).sort()).toEqual(['nested', 'runtime-only.txt'])
    expect(await readdir(path.join(destination, 'nested'))).toEqual(['main.js'])
    expect(await readFile(path.join(destination, 'nested/main.js'), 'utf8')).toBe('export const version = 64\n')
    expect(await readFile(path.join(destination, 'runtime-only.txt'), 'utf8')).toBe('private fixture artifact\n')
    await writeFile(path.join(destination, 'nested/main.js'), 'changed runtime contents\n')
    expect(await readFile(path.join(source, 'nested/main.js'), 'utf8')).toBe('export const version = 64\n')
  })
})
