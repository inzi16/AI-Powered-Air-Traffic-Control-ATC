import { Cloud, CloudRain, Compass, Gauge, Thermometer, Wind } from 'lucide-react';
import type { SimData } from '../hooks/useSimData';

export default function WeatherBoard({ sim }: { sim: SimData }) {
  const weather = sim.weather;
  if (!weather) {
    return (
      <div className="empty-canvas">
        <Cloud aria-hidden="true" />
        <h2>Weather feed unavailable</h2>
        <p>The simulator has not supplied a weather observation. Route guidance will not invent wind or visibility.</p>
      </div>
    );
  }

  const crosswind = Math.abs(Math.sin(((weather.wind_dir - sim.heading_mag) * Math.PI) / 180) * weather.wind_kts);
  return (
    <div className="weather-board">
      <header className="weather-board__header">
        <div>
          <span className="eyebrow">Live environment</span>
          <h2>{sim.nearest_airport?.icao || 'En route'} weather</h2>
        </div>
        <span className="scenario-chip"><span className="mode-dot" />Simulator observation</span>
      </header>
      <div className="weather-metrics">
        <WeatherMetric icon={<Wind />} label="Wind" value={`${String(Math.round(weather.wind_dir)).padStart(3, '0')} deg / ${Math.round(weather.wind_kts)} kt`} detail={`Crosswind component ${Math.round(crosswind)} kt`} />
        <WeatherMetric icon={<Gauge />} label="Altimeter" value={`${weather.qnh_hpa.toFixed(0)} hPa`} detail="Pressure reference" />
        <WeatherMetric icon={<CloudRain />} label="Visibility" value={`${weather.visibility_km.toFixed(1)} km`} detail={weather.ceiling_ft ? `Ceiling ${Math.round(weather.ceiling_ft).toLocaleString()} ft` : 'No ceiling reported'} />
        <WeatherMetric icon={<Thermometer />} label="Temperature" value={`${Math.round(weather.temp_c)} C`} detail={`Dewpoint ${Math.round(weather.dewpoint_c)} C`} />
      </div>
      <section className="weather-guidance">
        <Compass aria-hidden="true" />
        <div>
          <span className="eyebrow">Operational interpretation</span>
          <strong>{crosswind > 20 ? 'Review runway and crosswind limits' : 'Wind within a normal training envelope'}</strong>
          <p>Deterministic calculations use the current aircraft heading and observed wind. Final runway suitability must also consider runway geometry and aircraft limits.</p>
        </div>
      </section>
    </div>
  );
}

function WeatherMetric({ icon, label, value, detail }: { icon: React.ReactNode; label: string; value: string; detail: string }) {
  return (
    <article className="weather-metric">
      <span className="weather-metric__icon" aria-hidden="true">{icon}</span>
      <span className="eyebrow">{label}</span>
      <strong>{value}</strong>
      <p>{detail}</p>
    </article>
  );
}
