import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { TaskError } from '../domain/task.mjs'

const fail = () => new TaskError('INVALID', 'Presented file is unavailable or changed during verification')
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino
const sameVersion = (a, b) => sameFile(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs

/** Local host adapter. Host owns the verified workspace root and permission check. */
export async function createLocalFiles({ root, cwd = root, authorizePath, maxBytes = 32 * 1024 * 1024 }) {
  if (typeof authorizePath !== 'function' || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError('File authorization and a positive byte limit are required')
  }
  const canonicalRoot = await realpath(root)
  const canonicalCwd = await realpath(cwd)
  const isWithin = target => {
    const within = relative(canonicalRoot, target)
    return within !== '..' && !within.startsWith(`..${sep}`) && !isAbsolute(within)
  }
  if (!isWithin(canonicalCwd)) throw new TaskError('FORBIDDEN', 'Session directory is outside the workspace')

  function normalize(path) {
    if (typeof path !== 'string' || path.trim() === '' || path.includes('\0')) throw fail()
    const target = resolve(canonicalCwd, path)
    if (target === canonicalRoot || !isWithin(target)) {
      throw new TaskError('FORBIDDEN', 'Presented file is outside the authorized workspace')
    }
    return target
  }

  async function inspect(path, { captureBytes = 0 } = {}) {
    const target = normalize(path)
    if (await authorizePath(target) !== true) throw new TaskError('FORBIDDEN', 'Presented file access denied')
    try {
      if (await realpath(target) !== target) throw fail()
      const before = await lstat(target, { bigint: true })
      if (!before.isFile() || before.size > BigInt(maxBytes)) throw fail()

      const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        const opened = await handle.stat({ bigint: true })
        if (!opened.isFile() || !sameVersion(before, opened) || await realpath(target) !== target) throw fail()
        const hash = createHash('sha256')
        const buffer = Buffer.allocUnsafe(Math.min(maxBytes, 64 * 1024))
        const bytes = captureBytes > 0 && opened.size <= BigInt(captureBytes)
          ? Buffer.alloc(Number(opened.size)) : undefined
        let total = 0
        for (;;) {
          const { bytesRead } = await handle.read(buffer)
          if (bytesRead === 0) break
          total += bytesRead
          if (total > maxBytes) throw fail()
          hash.update(buffer.subarray(0, bytesRead))
          if (bytes) {
            if (total > bytes.length) throw fail()
            bytes.set(buffer.subarray(0, bytesRead), total - bytesRead)
          }
        }
        const after = await handle.stat({ bigint: true })
        const current = await lstat(target, { bigint: true })
        if (BigInt(total) !== opened.size || !sameVersion(opened, after) || !sameVersion(after, current) || await realpath(target) !== target) throw fail()
        return { version: hash.digest('hex'), size: total, bytes }
      } finally {
        await handle.close()
      }
    } catch (error) {
      if (error instanceof TaskError) throw error
      throw fail()
    }
  }
  return {
    root: canonicalRoot, normalize, inspect,
    async digest(path) { return (await inspect(path)).version },
  }
}
