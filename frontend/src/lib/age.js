// Human age label from a YYYY-MM-DD birthday: "5 months" up to 24 months, then "2 years 3 months".
// Returns null for no/invalid/future birthday. Shared by the Children list and Child detail.
//
// Past two years the months are still shown, because for a child this age they are the part that
// carries the information — "3 years" covers a twelve-month span over which sleep changes completely,
// and it is how a parent says it out loud. A whole number of years drops the months rather than
// printing "0 months".
export function ageLabel(birthday) {
  if (!birthday) return null;
  const b = new Date(birthday + 'T00:00:00');
  if (Number.isNaN(b.getTime())) return null;
  const now = new Date();
  let months = (now.getFullYear() - b.getFullYear()) * 12 + (now.getMonth() - b.getMonth());
  if (now.getDate() < b.getDate()) months -= 1;
  if (months < 0) return null;
  if (months < 24) return `${months} month${months === 1 ? '' : 's'}`;
  const years = Math.floor(months / 12);
  const rem = months % 12;
  const y = `${years} year${years === 1 ? '' : 's'}`;
  return rem === 0 ? y : `${y} ${rem} month${rem === 1 ? '' : 's'}`;
}
