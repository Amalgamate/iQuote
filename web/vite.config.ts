import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const previewFiles = new Map([
  ['/__ui_preview/public-site.html', 'public-site-mockup.html'],
  ['/__ui_preview/business-dashboard.html', 'customer-dashboard-mockup.html'],
  ['/__ui_preview/admin-dashboard.html', 'admin-dashboard-mockup.html'],
])

function localUiPreviewAssets() {
  return {
    name: 'iquote-local-ui-preview-assets',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
        const filename = previewFiles.get(pathname)
        if (!filename) return next()
        response.statusCode = 200
        response.setHeader('Content-Type', 'text/html; charset=utf-8')
        response.setHeader('Cache-Control', 'no-store')
        fs.createReadStream(path.join(projectRoot, 'scripts', filename)).pipe(response)
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), localUiPreviewAssets()],
})
