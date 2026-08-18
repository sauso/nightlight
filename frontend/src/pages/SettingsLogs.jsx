import AppHeader from '../components/AppHeader.jsx';
import LogViewer from '../components/LogViewer.jsx';
import EventLog from '../components/EventLog.jsx';
import RecentAlerts from '../components/RecentAlerts.jsx';
import DiagnosticsCard from '../components/DiagnosticsCard.jsx';

export default function SettingsLogs() {
  return (
    <>
      <AppHeader title="Logs" back={{ to: '/settings', label: 'Settings' }} />
      <main className="app-main">

        <DiagnosticsCard title="Report a problem" />

        <div className="card">
          <div className="card-title">Recent alerts</div>
          <RecentAlerts />
        </div>

        <div className="card">
          <div className="card-title">Camera history</div>
          <EventLog />
        </div>

        <div className="card">
          <div className="card-title">Recent logs</div>
          <LogViewer />
        </div>
      </main>
    </>
  );
}
