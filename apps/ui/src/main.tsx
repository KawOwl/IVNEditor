import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '#internal/index.css'
import { App } from '#internal/ui/App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
