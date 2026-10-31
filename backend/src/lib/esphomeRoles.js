// What an ESPHome entity measures, guessed from what the device reported about it (#506). A pure function with no
// imports, so a reader that needs the roles (lib/sleepSensor.js, #917) does not pull in esphomeManager.js and, through it,
// the transport and the `esphome-client` library. esphomeManager.js re-exports it, so its callers and its tests are
// unchanged: the behaviour is exactly what it was there.
//
// ⚠️ A GUESS BY NAME, not a contract. `device_class` is used when the device sets one of the five below; ESPHome has no
// device class for heart or breathing rate, so those two (and the radar's target count) are recognised by the entity's
// name or object id: "heart rate" / "heart_rate" / "heartrate", and "respiratory rate" / "respiration rate" /
// "breath rate" (the separator between the words is optional and may be any one character). A sensor whose
// configuration names them otherwise ("Breathing rate", "Pulse", "HR", "BPM", or a name in another language) is not
// recognised: its rows are kept, but nothing that reads by role (the sleep shadow, #917) sees it as a vital sign.
export function guessEsphomeCategory(entity) {
  const cls = String(entity.device_class || '').toLowerCase();
  if (['occupancy', 'illuminance', 'distance', 'temperature', 'humidity'].includes(cls)) return cls;
  const name = `${entity.name || ''} ${entity.object_id || ''}`.toLowerCase();
  if (/heart.?rate/.test(name)) return 'heart_rate';
  if (/(respirat\w*|breath).?rate/.test(name)) return 'respiratory_rate';
  if (/target.?number|num.?targets/.test(name)) return 'target_number';
  return null;
}
