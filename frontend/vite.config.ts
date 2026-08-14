import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const FRONTEND_ROOT = fileURLToPath(new URL('.', import.meta.url))
const BUILD_VERSION_PLACEHOLDER = "const BUILD_VERSION = 'dev';"
const BUILD_MANIFEST_PLACEHOLDER = 'const BUILD_ASSET_MANIFEST = [];'

type BuildAssetManifestEntry = {
  url: string
  revision: string
}

async function listBuildFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const nestedFiles = await Promise.all(entries
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      const path = resolve(directory, entry.name)
      return entry.isDirectory() ? listBuildFiles(path) : Promise.resolve([path])
    }))

  return nestedFiles.flat()
}

function digest(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex')
}

function injectServiceWorkerManifest(): Plugin {
  const outputDirectory = resolve(FRONTEND_ROOT, 'dist')

  return {
    name: 'smart-atc-service-worker-manifest',
    apply: 'build',
    enforce: 'post',
    async closeBundle() {
      const serviceWorkerPath = resolve(outputDirectory, 'sw.js')
      const buildFiles = (await listBuildFiles(outputDirectory))
        .filter((path) => path !== serviceWorkerPath)
      const manifest: BuildAssetManifestEntry[] = await Promise.all(buildFiles.map(async (path) => ({
        url: `/${relative(outputDirectory, path).split(sep).join('/')}`,
        revision: digest(await readFile(path)).slice(0, 20),
      })))
      const serializedManifest = JSON.stringify(manifest)
      const buildVersion = digest(serializedManifest).slice(0, 20)
      const source = await readFile(serviceWorkerPath, 'utf8')

      if (!source.includes(BUILD_VERSION_PLACEHOLDER) || !source.includes(BUILD_MANIFEST_PLACEHOLDER)) {
        throw new Error('Smart ATC service worker is missing its build-manifest injection placeholders.')
      }

      const injectedSource = source
        .replace(BUILD_VERSION_PLACEHOLDER, `const BUILD_VERSION = ${JSON.stringify(buildVersion)};`)
        .replace(BUILD_MANIFEST_PLACEHOLDER, `const BUILD_ASSET_MANIFEST = ${JSON.stringify(manifest, null, 2)};`)

      await writeFile(serviceWorkerPath, injectedSource)
    },
  }
}

export default defineConfig({
  cacheDir: '.vite-cache',
  plugins: [react(), injectServiceWorkerManifest()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
        ws: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
})
