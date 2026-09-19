import { api } from '../lib/api.js';
import Modal from './Modal.jsx';

// A bed-transition snapshot, enlarged. Extracted from NightReview so both the "Quick check-in?"
// prompt and the full recorded-events list open the exact same viewer, the same way ClipPlayerModal
// is shared for video. Exists because the review verdict a person gives is only as good as whether
// they could actually see the photo — a 160x120 thumbnail is enough to spot that a frame exists, not
// always enough to tell what happened in it (the owner's own words: some are "hard to confirm").
//
// `imagePath` is an API path, not a URL — resolved through api.url() here so the short-lived media
// token is attached, matching every other snapshot/clip render in the app.
export default function ImagePreviewModal({ title, imagePath, meta, onClose }) {
  return (
    <Modal title={title} onClose={onClose} wide>
      <img className="image-preview" src={api.url(imagePath)} alt="" />
      {meta ? <div className="clip-player__meta">{meta}</div> : null}
    </Modal>
  );
}
