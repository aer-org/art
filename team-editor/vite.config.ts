import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import os from 'os'
import path from 'path'

/**
 * Vite plugin that serves GET/POST /api/pipeline when ART_PROJECT_DIR is set.
 * Used by `art compose` to read/write __art__/PIPELINE.json directly.
 */
function artApiPlugin(): Plugin {
  return {
    name: 'art-api',
    configureServer(server) {
      server.middlewares.use('/api/project-files', (_req, res) => {
        const artDir = process.env.ART_PROJECT_DIR
        if (!artDir) {
          res.statusCode = 404
          res.end(JSON.stringify({ error: 'ART_PROJECT_DIR not set' }))
          return
        }
        const projectDir = path.dirname(artDir)
        try {
          const entries = fs.readdirSync(projectDir, { withFileTypes: true })
          const files = entries
            .filter((e: fs.Dirent) => !e.name.startsWith('.') && e.name !== path.basename(artDir))
            .map((e: fs.Dirent) => ({ name: e.name, isDirectory: e.isDirectory() }))
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(files))
        } catch {
          res.statusCode = 500
          res.end(JSON.stringify({ error: 'Failed to read project files' }))
        }
      })

      server.middlewares.use('/api/images', (_req, res) => {
        const imgPath = path.join(os.homedir(), '.config', 'aer-art', 'images.json')
        try {
          const data = fs.readFileSync(imgPath, 'utf-8')
          res.setHeader('Content-Type', 'application/json')
          res.end(data)
        } catch {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({}))
        }
      })

      server.middlewares.use('/api/pipeline', (req, res) => {
        const artDir = process.env.ART_PROJECT_DIR
        if (!artDir) {
          res.statusCode = 404
          res.end(JSON.stringify({ error: 'ART_PROJECT_DIR not set' }))
          return
        }
        const file = path.join(artDir, 'PIPELINE.json')

        if (req.method === 'GET') {
          try {
            const data = fs.readFileSync(file, 'utf-8')
            res.setHeader('Content-Type', 'application/json')
            res.end(data)
          } catch {
            res.statusCode = 404
            res.end(JSON.stringify({ error: 'PIPELINE.json not found' }))
          }
          return
        }

        if (req.method === 'POST') {
          let body = ''
          req.on('data', (chunk: Buffer) => { body += chunk.toString() })
          req.on('end', () => {
            try {
              // Validate JSON
              JSON.parse(body)
              fs.writeFileSync(file, body)
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ ok: true }))
            } catch (err) {
              res.statusCode = 400
              res.end(JSON.stringify({ error: (err as Error).message }))
            }
          })
          return
        }

        res.statusCode = 405
        res.end()
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), artApiPlugin()],
})
