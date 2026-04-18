import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import DescentTest from './DescentTest.jsx'
import './index.css'

// Standalone route: /descents.html bypasses App entirely.
// Hash route: #descents inside App also works but shares App's API calls.
const path = window.location.pathname
const isStandalone = path === '/descents' || path === '/descents.html'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {isStandalone ? <DescentTest /> : <App />}
  </React.StrictMode>
)
