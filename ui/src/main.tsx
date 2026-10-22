import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import StartupGate from './components/StartupGate'
import { verifyAppDeployment } from './lib/client'

// Apply the saved theme before the first paint so the startup screen matches the app.
try {
  if (window.localStorage.getItem('ckb-dex-theme') === 'light') {
    document.documentElement.setAttribute('data-theme', 'light')
  }
} catch {
  // localStorage unavailable (private browsing, etc.) - fall back to the default dark theme
}

createRoot(document.getElementById('root')!).render(
  <StartupGate verify={verifyAppDeployment}>
    <StrictMode>
      <App />
    </StrictMode>
  </StartupGate>,
)
