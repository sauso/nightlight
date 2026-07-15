export function getGreeting(timezone) {
  let hour;
  try {
    hour = parseInt(
      new Intl.DateTimeFormat('en-US', {
        hour: 'numeric',
        hourCycle: 'h23',
        timeZone: timezone,
      }).format(new Date()),
      10
    );
  } catch {
    hour = new Date().getHours();
  }

  if (hour >= 5 && hour < 12) return 'Good morning';
  if (hour >= 12 && hour < 17) return 'Good afternoon';
  if (hour >= 17 && hour < 22) return 'Good evening';
  return 'Good night';
}

export function getCommonTimezones() {
  if (typeof Intl.supportedValuesOf === 'function') {
    try {
      return Intl.supportedValuesOf('timeZone');
    } catch {
      // fall through to the static list below
    }
  }
  return [
    'UTC',
    'Australia/Melbourne',
    'Australia/Sydney',
    'Australia/Brisbane',
    'Australia/Perth',
    'Australia/Adelaide',
    'America/New_York',
    'America/Chicago',
    'America/Denver',
    'America/Los_Angeles',
    'America/Sao_Paulo',
    'Europe/London',
    'Europe/Paris',
    'Europe/Berlin',
    'Europe/Moscow',
    'Africa/Johannesburg',
    'Asia/Dubai',
    'Asia/Kolkata',
    'Asia/Shanghai',
    'Asia/Tokyo',
    'Asia/Singapore',
    'Pacific/Auckland',
  ];
}
