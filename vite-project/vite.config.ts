import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
//
// `base` controls the public path assets are served from. On GitHub Pages a
// project site is served from https://<user>.github.io/<repo>/, so assets must
// be referenced relative to "/<repo>/". The deploy workflow sets VITE_BASE to
// the `base_path` output of actions/configure-pages, which is e.g. "/my-repo"
// for a project site or "" for a user/organization site.
//
// Vite expects `base` to begin and end with a slash, so normalize here:
//  - ""            -> "/"
//  - "/my-repo"    -> "/my-repo/"
//  - "/" (default) -> "/"
function normalizeBase(value: string | undefined): string {
  if (!value || value === '/') return '/'
  const withLeading = value.startsWith('/') ? value : `/${value}`
  return withLeading.endsWith('/') ? withLeading : `${withLeading}/`
}

export default defineConfig({
  base: normalizeBase(process.env.VITE_BASE),
  plugins: [react()],
})
