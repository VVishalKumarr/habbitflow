// Static hosts that don't rewrite unknown paths to index.html (GitHub Pages)
// serve 404.html instead; making it a copy of index.html lets deep links like
// /help/how-to-use-timetable load the app. Cloudflare Pages / Netlify handle
// this themselves (Cloudflare: not_found_handling in wrangler.jsonc).
import { copyFileSync, existsSync } from 'node:fs'

if (existsSync('dist/index.html')) copyFileSync('dist/index.html', 'dist/404.html')
