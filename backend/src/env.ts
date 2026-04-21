import path from 'node:path'
import { fileURLToPath } from 'node:url'

import dotenv from 'dotenv'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const backendRoot = path.resolve(__dirname, '..')

// Load backend/.env then backend/.env.local (local overrides)
dotenv.config({ path: path.join(backendRoot, '.env') })
dotenv.config({ path: path.join(backendRoot, '.env.local') })
