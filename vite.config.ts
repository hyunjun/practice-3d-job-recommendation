import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: { middlewareMode: true },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 850,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'three', test: /node_modules\/three\// },
            { name: 'pdf', test: /node_modules\/pdfjs-dist\// },
            { name: 'documents', test: /node_modules\/mammoth\// },
          ],
        },
      },
    },
  },
})
