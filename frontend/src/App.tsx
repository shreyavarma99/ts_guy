import './App.css'
import { MapView } from './components/MapView'

function App() {
  return (
    <div className="appShell">
      <MapView />
      <div className="hud">
        <div className="title">3D Map</div>
        <div className="subtitle">
          Zoom in to see more detail. Pitch/rotate to explore buildings.
        </div>
      </div>
    </div>
  )
}

export default App
