import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { verifyAppDeployment } from './lib/client'

const root = createRoot(document.getElementById('root')!)
root.render(<p role="status">Checking CKB deployment…</p>)
verifyAppDeployment().then(() => {
  root.render(<StrictMode><App /></StrictMode>)
}).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unable to verify CKB deployment"
  root.render(<p role="alert">{message}</p>)
})
