import AppHeader from '../components/AppHeader.jsx';

// Placeholder — the caregiver-visible detection-events feed (with snapshots) is built in
// Phase 8. Kept as a real route now so the bottom-nav Alerts tab works from Phase 1 on.
export default function Alerts() {
  return (
    <>
      <AppHeader title="Alerts" />
      <main className="app-main">
        <div className="empty-state">No alerts yet.</div>
      </main>
    </>
  );
}
