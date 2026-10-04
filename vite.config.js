import process from 'node:process'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
// VITE_BASE=./ (set by the GitHub Pages workflow) makes asset paths relative, so the demo
// works under any repo path; local and APK builds use '/'.
export default defineConfig({
  base: process.env.VITE_BASE || '/',
  plugins: [react()],
})
