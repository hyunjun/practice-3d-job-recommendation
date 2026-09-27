/**
 * Test-only default `npm run test:e2e` server, intended for the root test layout.
 * Route-specific suites may override these synthetic responses. Missing routes
 * can never enter the live collector, even from a fresh context or saved-page bug.
 * ORBIT_TEST_MODE=production serves the already-built client from dist.
 */
import express from 'express'
import { access, realpath } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { ViteDevServer } from 'vite'
import { defaultPublicSources } from './default-public'

const repository = fileURLToPath(new URL('../../', import.meta.url))
const port = Number(process.env.PORT ?? 5173)
const hostname = process.env.HOST ?? '127.0.0.1'
const mode = process.env.ORBIT_TEST_MODE ?? 'development'
if (mode !== 'development' && mode !== 'production')
  throw new Error('ORBIT_TEST_MODE must be development or production.')
if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 8787
  || !['127.0.0.1', 'localhost'].includes(hostname)) {
  throw new Error('The default E2E fixture server requires an owned loopback port other than 8787.')
}

// This process has no upstream transport. Product server/index and server/catalog
// are deliberately not loaded. A future accidental fetch fails before sending.
globalThis.fetch = async () => { throw new Error('Default E2E server attempted an unexpected upstream request.') }
const { compressResponses, createApiRouter } = await import('../../server/http')

const sources = defaultPublicSources(new Date().toISOString())
const app = express()
app.disable('x-powered-by')
app.use((_request, response, next) => {
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  next()
})
app.get('/api/health', (_request, response) => {
  response.json({
    status: 'ok', app: 'orbit', mode,
    fixture: 'synthetic-public', fixtureCompanies: 3, fixtureJobs: 29, fixtureCities: 22,
  })
})
// Install every data endpoint before Vite starts and before any page can navigate.
app.use('/api', createApiRouter(sources))

const server = createHttpServer(app)
let vite: ViteDevServer | undefined
if (mode === 'production') {
  const dist = path.join(repository, 'dist')
  await access(path.join(dist, 'index.html'))
  app.use(compressResponses)
  app.use(express.static(dist, {
    maxAge: '1h',
    setHeaders(response, filePath) {
      if (filePath.includes(`${path.sep}assets${path.sep}`))
        response.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
      if (filePath.endsWith(`${path.sep}index.html`)) response.setHeader('Cache-Control', 'no-cache')
    },
  }))
  app.get('/{*path}', (_request, response) => response.sendFile(path.join(dist, 'index.html')))
} else {
  // Retain the predev PDF assets step; this only copies installed package files.
  await import(pathToFileURL(path.join(repository, 'scripts/prepare-assets.mjs')).href)
  const { createServer } = await import('vite')
  vite = await createServer({
    root: repository,
    cacheDir: path.join(repository, '.local/e2e-default/vite'),
    server: {
      middlewareMode: true,
      // HMR shares this owned HTTP port instead of opening the fixed 24678 port.
      hmr: { server },
      // COW apps can serve dependency fonts through their read-only symlink.
      fs: { allow: [repository, await realpath(path.join(repository, 'node_modules'))] },
    },
    appType: 'spa',
  })
  app.use(vite.middlewares)
}
const closeTooling = async () => { await vite?.close() }
server.listen(port, hostname, () => {
  console.log(`ORBIT synthetic public E2E server (${mode}): http://${hostname}:${port}`)
})
server.on('error', error => {
  console.error(error.message)
  void closeTooling().finally(() => { process.exitCode = 1 })
})
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close(() => { void closeTooling().finally(() => process.exit(0)) })
    setTimeout(() => process.exit(1), 3000).unref()
  })
}
