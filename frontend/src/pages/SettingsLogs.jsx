import AppHeader from '../components/AppHeader.jsx';
import LogViewer from '../components/LogViewer.jsx';
import EventLog from '../components/EventLog.jsx';
import RecentAlerts from '../components/RecentAlerts.jsx';
import DiagnosticsCard from '../components/DiagnosticsCard.jsx';
import ServerCard from '../components/ServerCard.jsx';

export default function SettingsLogs() {
  return (
    <>
      <AppHeader title="Logs" back={{ to: '/settings', label: 'Settings' }} />
      <main className="app-main">

        <ServerCard />

        <DiagnosticsCard title="Report a problem" />

        <div className="card">
          <h2 className="card-heading">Recent alerts</h2>
          <RecentAlerts />
        </div>

        <div className="card">
          <h2 className="card-heading">Camera history</h2>
          <EventLog />
        </div>

        <div className="card">
          <h2 className="card-heading">Recent logs</h2>
          <LogViewer />
        </div>
      </main>
    </>
  );
}
