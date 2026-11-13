import { Lock } from 'lucide-react';
import DiscoveryCard from './DiscoveryCard.jsx';

const HELP = 'No devices found. Discovery needs Nightlight on the same network segment as the devices. The default Docker bridge does not expose LAN multicast; another VLAN needs an mDNS relay. You can always add a device manually.';

export default function EsphomeDiscovery({ onPick, onAddManually, full = false, loading = false }) {
  return <DiscoveryCard scanPath="/esphome/discover" title="Find devices" subtitle="ESPHome devices on your network"
    idleLabel="Find devices on my network" help={HELP} manualLabel="Add by IP address"
    onAddManually={onAddManually} full={full} loading={loading}
    limitNote="You have 8 devices, which is the limit. Delete one to add another."
    resultsLabel="Devices found" onPick={onPick}
    describe={(candidate) => ({
      name: candidate.name,
      line: `${candidate.ip}:${candidate.port}${candidate.board ? ` · ${candidate.board}` : ''}`,
      extra: candidate.version,
      chips: candidate.encrypted ? [{ text: 'Encryption advertised', icon: Lock }] : [],
      added: candidate.alreadyAdded === true,
    })} />;
}
