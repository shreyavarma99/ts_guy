import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// Note: StrictMode is intentionally off here. Mapbox GL keeps async style/tile work tied to a
// specific Map instance; React 18 Strict dev double-mount + long-running fetches caused removed
// maps to receive callbacks and throw (e.g. "getOwnSource" on undefined).
createRoot(document.getElementById('root')!).render(<App />)
