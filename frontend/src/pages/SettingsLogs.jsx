import AppHeader from '../components/AppHeader.jsx';
import SettingsBack from '../components/SettingsBack.jsx';
import LogViewer from '../components/LogViewer.jsx';
import EventLog from '../components/EventLog.jsx';
import RecentAlerts from '../components/RecentAlerts.jsx';

export default function SettingsLogs() {
  return (
    <>
      <AppHeader title="Logs" />
      <main className="app-main">
        <SettingsBack />

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
