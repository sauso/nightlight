import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// #943: Keep icon regeneration repeatable while the owner finalises the artwork.
// Pillow handles high-quality downsampling; run `python -m pip install Pillow` if needed.
const script = fileURLToPath(new URL('./make-icons.py', import.meta.url));
execFileSync(process.platform === 'win32' ? 'python' : 'python3', [script], { stdio: 'inherit' });
