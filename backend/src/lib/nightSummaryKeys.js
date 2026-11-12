// The keys the night summary can send, and the parameters each one carries (sleep score plan, phase 3, Design 5).
//
// ★ ONE TABLE, READ BY BOTH SIDES SO THEY CANNOT DRIFT. lib/nightSummary.js (the server, which picks the keys) builds
// every observation from OBSERVATION_PARAMS and refuses to emit one whose params differ from it. The phrase library
// in the browser (frontend/src/lib/nightSummaryPhrases.js) cannot import from the backend (separate packages, and the
// browser build never sees this folder), so its test imports THIS file and checks the library against it: a key or a
// param added here without a phrase or a formatter there, or the other way round, fails a test. That is the whole
// reason this is its own file: it has no imports, so a test in either package can load it without a database.
//
// The server sends KEYS and raw parameters, never wording (the wording is the browser's, so a retuned phrase needs no
// server release and an LLM phase can replace the library later). Parameter units, every one raw:
//   minutes ............ whole or fractional minutes (a usual is a median and can be a half minute)
//   count, wakes ....... a number of wake-ups
//   *_at ............... a UTC time as the database stores it, 'YYYY-MM-DD HH:MM:SS' (the browser puts it in the home zone)
//   min_c, max_c ....... absolute degrees Celsius, never a difference of two temperatures (the browser converts to
//                        Fahrenheit when the household uses it, and a difference does not convert like a reading)
//   coverage_percent ... 0 to 100
//   direction .......... 'more' | 'less' | 'about_the_same': how the night compared with the child's usual

// The headline: a class derived from the score's components, or one of two neutral lines for a night with no score.
export const HEADLINE_KEYS = Object.freeze([
  'settled', 'typical', 'mixed', 'unsettled', 'neutral_last_night', 'neutral_so_far',
]);

export const DIRECTIONS = Object.freeze(['more', 'less', 'about_the_same']);

// key -> its parameter names. The order is also the order ties are broken in (nightSummary.js KEY_ORDER reads it), so
// a new key goes where it should lose a tie.
export const OBSERVATION_PARAMS = Object.freeze({
  total_sleep: Object.freeze(['minutes']),
  total_sleep_vs_usual: Object.freeze(['minutes', 'usual_minutes', 'direction']),
  wake_ups: Object.freeze(['count']),
  wake_ups_vs_usual: Object.freeze(['count', 'usual_count', 'direction']),
  longest_stretch: Object.freeze(['minutes']),
  longest_stretch_vs_usual: Object.freeze(['minutes', 'direction']),
  settling_time: Object.freeze(['minutes']),
  wake_clustering: Object.freeze(['count', 'from_at', 'to_at']),
  room_activity_near_wakes: Object.freeze(['count', 'wakes']),
  temperature_range: Object.freeze(['min_c', 'max_c']),
  reduced_coverage: Object.freeze(['coverage_percent', 'unwatched_minutes']),
  building_baseline: Object.freeze([]),
  no_sleep_detected: Object.freeze([]),
  // A night whose two times a person typed in after the detector saw an empty bed (sleepReviews.js asScoredFromEmpty).
  times_entered_by_hand: Object.freeze([]),
  sleep_span: Object.freeze(['onset_at', 'wake_at']),
  // A night a person marked "no one was in the bed" (sleepReviews.js asNobodyInBed).
  nobody_in_bed: Object.freeze([]),
  // A night still in progress (phase 4): plain "so far" facts, never a comparison with the usual. They go last: the
  // in-progress selection does not rank them against the others (nightSummary.js soFarObservations lists them in
  // this order), so their place here breaks no tie. Params are raw, as everywhere else.
  total_sleep_so_far: Object.freeze(['minutes']),
  wake_ups_so_far: Object.freeze(['count']),
  longest_stretch_so_far: Object.freeze(['minutes']),
});
