import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import ErrorBoundary from './components/ErrorBoundary'
import { initTheme } from './lib/theme'
import './index.css'

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Нет #root в index.html')

initTheme()

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)
