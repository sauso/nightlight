// Which rows of `night.wakes` are the wake-ups the page counts, and which is the morning wake.
//
// The server builds `wakes` from the counted mid-night runs and then ADDS the morning wake so an alert or clip at the departure
// has a row to attach to (sleepAnalysis.js, "THE MORNING WAKE ITSELF"). It either extends the last counted run (then the list
// and `wake_count` agree) or, when there is a real gap, pushes ONE standalone row at the END (then the list is exactly one
// longer than `wake_count`). `wake_count` is the scored, mid-night figure the summary shows, so the tab count and the summary
// must come from the same rows: the standalone row is the morning wake, not a wake-up. It is recognised by that arithmetic and
// nothing else, because the payload carries no flag. An older server without `wake_count` is not split (everything counts).
//
// Display only: nothing here changes a stored or reported number.
export function splitMorningWake(wakes, wakeCount) {
  const list = Array.isArray(wakes) ? wakes : [];
  if (Number.isInteger(wakeCount) && list.length === wakeCount + 1) {
    return { counted: list.slice(0, -1), morning: list[list.length - 1] };
  }
  return { counted: list, morning: null };
}
