// A Nightlight Camera running invented bench data says so; every place its readings appear shows this, so nobody mistakes
// them for a real room. Its readings are also kept out of every night's figures by the server.
export default function SimulatedBadge({ className = '' }) {
  return (
    <span className={`simulated-badge ${className}`.trim()}
      title="This camera is sending invented readings (test data). They can be shown, but are never part of a night's sleep figures, score or summary.">
      Simulated sensors
    </span>
  );
}
