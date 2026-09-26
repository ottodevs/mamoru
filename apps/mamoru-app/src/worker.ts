import { createApp } from './api/app.ts'

// mamoru-app Worker (plan §19.1): /api/* runs here first; everything else is the SPA from ASSETS.
export default createApp()
