import { Link } from 'react-router-dom';
import { CalendarDays, ChevronRight } from 'lucide-react';
import { reportPagePath } from '../lib/reportFormat.js';

// The quiet way into the weekly and monthly report (issue #1236): one text link with a calendar icon and a chevron, used on the
// child's page (under the night card) and on the sleep page (under the seven-night strip). A link, not a card or a button, so it
// does not compete with the night above it; it is always shown (any signed-in user can read a report, an admin and a caregiver
// alike) and goes to the report for the child it is given. The icon and chevron carry no information the words do not.
export default function ReportLink({ childId, className = '' }) {
  return (
    <Link className={`report-link ${className}`.trim()} to={reportPagePath(childId)}>
      <CalendarDays size={16} aria-hidden="true" />
      <span>Weekly and monthly reports</span>
      <ChevronRight size={16} aria-hidden="true" />
    </Link>
  );
}
