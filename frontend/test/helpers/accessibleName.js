// "Label in name" (WCAG 2.5.3): a control's accessible name must contain the text it PRINTS, and in this app starts with it,
// so a voice-control user saying what they see ("Sun 7:00 pm") matches the control and a screen-reader user hears the
// same words first. A control whose name is an aria-label that opens with something else (a verb, a camera) fails it.
import { computeAccessibleName } from 'dom-accessibility-api';

const squash = (s) => String(s).replace(/\s+/g, ' ').trim();

// The accessible name of an element, as the browser would compute it (aria-label wins over content).
export const accessibleName = (el) => squash(computeAccessibleName(el));

// The text the control prints. `textContent` on purpose, not the accessible text: the chips inside these buttons are
// `aria-hidden` (so they are not read twice), but they are exactly what a sighted voice-control user can see and say.
export const printedText = (el) => squash(el.textContent);

// True when the name begins with the printed text. A symbol-only print (the sleep strip's dash for "no score") is not a
// word anyone says, so callers pass the printed words they mean instead of the whole text.
export const nameStartsWithPrinted = (el, printed = printedText(el)) => accessibleName(el).startsWith(squash(printed));
