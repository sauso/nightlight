import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App.jsx';
import { applyTheme } from './lib/theme.js';
import './index.css';

// Stamp the stored (or system) theme onto <html> before React renders, so the app paints
// straight into the right palette instead of flashing the default first.
applyTheme();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>
);
