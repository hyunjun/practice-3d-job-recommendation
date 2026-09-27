import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { cp, lstat, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
/**
 * macOS cp -c supports clonefile even when Node/libuv returns ENOSYS.
 * Both paths fall back to normal copying on filesystems without reflinks.
 * Unlike hard links, both copies remain safe to modify or remove independently.
 */
export async function copyFixture(source: string, destination: string) {
  if (process.platform === 'darwin') {
    const from = path.resolve(source)
    const to = path.resolve(destination)
    const directory = (await lstat(from)).isDirectory()
    await mkdir(path.dirname(to), { recursive: true })
    // A trailing slash copies contents into an existing directory, matching
    // fs.cp's recursive merge rather than nesting another source directory.
    await exec('/bin/cp', ['-cR', directory ? `${from}${path.sep}` : from, to])
    return
  }
  await cp(source, destination, { recursive: true, mode: constants.COPYFILE_FICLONE })
}
