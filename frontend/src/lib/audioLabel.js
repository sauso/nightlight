// A missing or unrecognised result says nothing about what was heard: analysis may be off or the clip absent.
const AUDIO_LABEL_TEXT = { cry: 'Crying', cough: 'Coughing', voice: 'Talking' };

export function audioLabelText(label) {
  return Object.hasOwn(AUDIO_LABEL_TEXT, label) ? AUDIO_LABEL_TEXT[label] : null;
}
