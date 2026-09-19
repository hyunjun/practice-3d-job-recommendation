import express from 'express'
import path from 'node:path'
import { createSampleCatalog } from '../shared/sample'
import { getPublicCatalog, getPublicPostingStatus } from './catalog'
import { CatalogUnavailableError } from './catalog-service'

const app = express()
const port = Number(process.env.PORT ?? 5173)
const hostname = process.env.HOST ?? '127.0.0.1'
const production = process.argv.includes('--production') || process.env.NODE_ENV === 'production'

app.disable('x-powered-by')
app.use((_request, response, next) => {
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  next()
})

app.get('/api/health', (_request, response) => {
  response.json({ status: 'ok', app: 'orbit', mode: production ? 'production' : 'development' })
})

app.get('/api/catalog', async (request, response) => {
  response.setHeader('Cache-Control', 'no-store')
  const source = request.query.source ?? 'sample'
  if (source !== 'sample' && source !== 'public' && source !== 'greenhouse') {
    response.status(400).json({ error: '지원하지 않는 데이터 소스입니다.' })
    return
  }
  try {
    // The legacy query is accepted while clients migrate to provider-independent public mode.
    const catalog = source !== 'sample' ? await getPublicCatalog(request.query.refresh === '1') : createSampleCatalog()
    response.json(catalog)
  } catch (error) {
    const retryAt = error instanceof CatalogUnavailableError ? error.retryAt : undefined
    if (retryAt) response.setHeader('Retry-After', Math.max(0, Math.ceil((Date.parse(retryAt) - Date.now()) / 1000)))
    response.status(503).json({
      error: error instanceof Error ? error.message : '공고를 불러오지 못했습니다.',
      ...(error instanceof CatalogUnavailableError ? { retryAt, code: error.code } : {}),
    })
  }
})

// This fixed public-board index never receives saved job IDs, notes or profile data.
app.get('/api/posting-status', async (request, response) => {
  response.setHeader('Cache-Control', 'no-store')
  try {
    response.json(await getPublicPostingStatus(request.query.refresh === '1'))
  } catch {
    response.setHeader('Retry-After', '60')
    response.status(503).json({
      error: '게시 상태를 불러오지 못했어요. 잠시 후 다시 확인해 주세요.',
      retryAt: new Date(Date.now() + 60_000).toISOString(),
    })
  }
})

app.use('/api', (_request, response) => {
  response.status(404).json({ error: '존재하지 않는 API입니다.' })
})

if (production) {
  app.use(express.static(path.resolve('dist'), {
    maxAge: '1h',
    setHeaders(response, filePath) {
      if (filePath.includes('/assets/')) response.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
      if (filePath.endsWith('index.html')) response.setHeader('Cache-Control', 'no-cache')
    },
  }))
  app.get('/{*path}', (_request, response) => response.sendFile(path.resolve('dist/index.html')))
} else {
  const { createServer } = await import('vite')
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' })
  app.use(vite.middlewares)
}

const server = app.listen(port, hostname, () => {
  console.log(`\n  ORBIT · 내 커리어의 다음 좌표\n  http://${hostname === '127.0.0.1' ? 'localhost' : hostname}:${port}\n`)
})

server.on('error', error => {
  console.error('ORBIT 서버를 시작하지 못했습니다:', error.message)
  process.exitCode = 1
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 3000).unref()
  })
}
