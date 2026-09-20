import express from 'express'
import path from 'node:path'
import { getProgressivePublicCatalog, getPublicCatalog, getPublicCatalogProgress, getPublicPostingStatus, initializePublicCatalog } from './catalog'
import { compressResponses, createApiRouter } from './http'

try { await initializePublicCatalog() }
catch (error) {
  console.error('ORBIT 공개 게시판 설정을 확인해 주세요:', error instanceof Error ? error.message : '설정을 읽지 못했습니다.')
  process.exit(1)
}

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

app.use('/api', createApiRouter({
  getCatalog: getPublicCatalog, getPostingStatus: getPublicPostingStatus,
  getProgressiveCatalog: getProgressivePublicCatalog, getCatalogProgress: getPublicCatalogProgress,
}))

if (production) {
  app.use(compressResponses)
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
