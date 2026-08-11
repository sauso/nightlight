import AppHeader from '../components/AppHeader.jsx';
import LogViewer from '../components/LogViewer.jsx';
import EventLog from '../components/EventLog.jsx';
import RecentAlerts from '../components/RecentAlerts.jsx';

export default function SettingsLogs() {
  return (
    <>
      <AppHeader title="Logs" back={{ to: '/settings', label: 'Settings' }} />
      <main className="app-main">

        <div className="section-title">Recent alerts</div>
        <RecentAlerts />

        <div className="section-title">Camera history</div>
        <EventLog />

        <div className="section-title">Recent logs</div>
        <LogViewer />
      </main>
    </>
  );
}
