import fs from 'node:fs';

const [mode, record, ...argv] = process.argv.slice(2);
if (record !== '-') fs.appendFileSync(record, JSON.stringify(argv) + '\n');
if (mode === 'login') {
  process.stdout.write('Visit https://login.tailscale.com/a/approved_123\n');
  setInterval(() => {}, 1000);
} else if (mode === 'hostile') {
  process.stdout.write('javascript:bad https://login.tailscale.com.evil/a/no https://login.tailscale.com/b/no\n');
  process.exit(1);
} else if (mode === 'huge') {
  process.stdout.write('x'.repeat(20000));
  setInterval(() => {}, 1000);
} else if (mode === 'hang') setInterval(() => {}, 1000);
else if (mode === 'garbage') process.stdout.write('{bad');
else if (mode === 'status') process.stdout.write(JSON.stringify({ BackendState: 'Running', Self: {
  TailscaleIPs: ['100.64.1.2', '100.128.1.2', '192.168.1.1', '::1'], DNSName: 'nightlight.example.ts.net.',
} }));
else if (mode === 'consent') { process.stdout.write('Visit https://login.tailscale.com/admin/feature/serve\n'); process.exit(1); }
