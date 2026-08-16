import { useEffect, useMemo, useState } from 'react';
import { Thermometer, Droplet } from 'lucide-react';
import { api } from '../lib/api.js';
import { useSettings } from '../lib/SettingsContext.jsx';

// Last-24h temperature & humidity for a camera that has an MQTT sensor topic, shown on the Child
// detail page. Readings come from the sensor_readings history (sampled every 5 min server-side);
// temperature is stored in Celsius and converted here to the user's unit. Inline SVG sparklines —
// no chart library — one per series that actually has data.

// A single-series sparkline. Scales to its own container width; the line stays crisp via a
// non-scaling stroke over a stretched viewBox. Draws nothing meaningful for < 2 points.
function Sparkline({ points, color, height = 56 }) {
  if (points.length < 2) return null;
  const vals = points.map((p) => p.v);
  let min = Math.min(...vals);
  let max = Math.max(...vals);
  if (max - min < 0.5) { min -= 0.5; max += 0.5; } // avoid a flat line pinned to the edges
  const span = max - min;
  const n = points.length;
  const coords = points.map((p, i) => {
    const x = (i / (n - 1)) * 100;
    const y = height - 4 - ((p.v - min) / span) * (height - 8);
    return [x, y];
  });
  const d = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`).join(' ');
  const area = `${d} L100 ${height} L0 ${height} Z`;
  const [lx, ly] = coords[coords.length - 1];
  return (
    <svg className="spark" width="100%" height={height} viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <path d={area} fill={color} opacity="0.10" />
      <path d={d} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke"
        strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={lx} cy={ly} r="2.5" fill={color} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Series({ Icon, label, color, unit, points, format }) {
  if (points.length === 0) return null;
  const vals = points.map((p) => p.v);
  const last = vals[vals.length - 1];
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  return (
    <div className="sensor-series">
      <div className="sensor-series__head">
        <span className="sensor-series__label"><Icon size={15} aria-hidden="true" /> {label}</span>
        <span className="sensor-series__now">{format(last)}{unit}</span>
      </div>
      <Sparkline points={points} color={color} />
      <div className="sensor-series__range">
        <span>low {format(lo)}{unit}</span>
        <span>high {format(hi)}{unit}</span>
      </div>
    </div>
  );
}

export default function SensorHistoryCard({ camera }) {
  const { settings } = useSettings();
  const toF = settings.temp_unit === 'F';
  const [readings, setReadings] = useState(null); // null = loading

  useEffect(() => {
    let alive = true;
    api.get(`/cameras/${camera.id}/sensor-history?hours=24`)
      .then((r) => { if (alive) setReadings(Array.isArray(r?.readings) ? r.readings : []); })
      .catch(() => { if (alive) setReadings([]); });
    return () => { alive = false; };
  }, [camera.id]);

  const { temp, humidity } = useMemo(() => {
    const t = [];
    const h = [];
    for (const r of readings || []) {
      if (typeof r.temperature === 'number') t.push({ v: toF ? (r.temperature * 9) / 5 + 32 : r.temperature });
      if (typeof r.humidity === 'number') h.push({ v: r.humidity });
    }
    return { temp: t, humidity: h };
  }, [readings, toF]);

  if (readings === null) return null; // don't flash an empty card while loading
  const hasData = temp.length > 0 || humidity.length > 0;

  return (
    <div className="card sensor-card">
      <div className="sensor-card__title">Room climate · last 24h</div>
      {!hasData ? (
        <div className="camera-tile__sub" style={{ padding: '6px 2px' }}>
          Collecting data — temperature and humidity will chart here once a few readings come in from
          <strong> {camera.name}</strong>.
        </div>
      ) : (
        <div className="sensor-grid">
          <Series Icon={Thermometer} label="Temperature" color="#e0894a" unit={`°${settings.temp_unit}`}
            points={temp} format={(v) => v.toFixed(1)} />
          <Series Icon={Droplet} label="Humidity" color="#4f9bd6" unit="%"
            points={humidity} format={(v) => String(Math.round(v))} />
        </div>
      )}
    </div>
  );
}
