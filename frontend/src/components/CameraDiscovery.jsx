import { Video } from 'lucide-react';
import DiscoveryCard from './DiscoveryCard.jsx';

const HELP = 'No cameras found. Discovery needs Nightlight on the same network segment as the cameras (host networking, or a network with its own address); the default Docker bridge and cameras on another VLAN are not visible unless the router relays mDNS. You can always add a camera manually.';

export default function CameraDiscovery({ onPick, autoStart = false, selectedId = null, onAddManually, children = null }) {
  return <DiscoveryCard scanPath="/cameras/discover" autoStart={autoStart} title="Find cameras"
    subtitle="Cameras on your network" idleLabel="Find cameras on my network" help={HELP}
    manualLabel="Add a camera manually" onAddManually={onAddManually}
    resultsLabel="Cameras found" ResultIcon={Video} selectedId={selectedId} onPick={onPick}
    describe={(candidate) => ({
      name: candidate.name,
      line: candidate.ip,
      extra: candidate.product,
      chips: [
        ...(candidate.sources?.includes('mdns') ? [{ text: 'Thingino' }] : []),
        ...(candidate.sources?.includes('onvif') ? [{ text: 'ONVIF' }] : []),
      ],
      added: candidate.alreadyAdded === true,
    })}>{children}</DiscoveryCard>;
}
