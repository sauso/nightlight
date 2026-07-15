import { Router } from 'express';
import db from '../db.js';

const router = Router();

router.get('/', (req, res) => {
  const settings = db.prepare('SELECT * FROM settings WHERE id = ?').get('app');
  const name = settings?.app_name || 'Nightlight Baby Monitor';

  res.type('application/manifest+json').json({
    name,
    short_name: name.length > 14 ? 'Nightlight' : name,
    description: 'Self-hosted baby monitor with live camera views for the nursery.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait-primary',
    background_color: '#12172b',
    theme_color: '#12172b',
    icons: [
      // Chrome's own install-dialog preview uses whatever has purpose "any" and applies
      // its own rounded-square crop - separate from what the Android launcher does with
      // "maskable". Using the same full-bleed artwork for both means neither one reveals
      // the old icon's inner shape boundary. The original illustrated icon is still used
      // in-app (header, login, browser tab) via direct references, just not listed here.
      { src: '/icons/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ],
  });
});

export default router;
