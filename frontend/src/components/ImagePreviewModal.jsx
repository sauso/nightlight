import { api } from '../lib/api.js';
import Modal from './Modal.jsx';

// A saved bed-transition frame, enlarged. #907 brings this viewer back for the sleep detail page's Room
// activity rows: it was removed with the old morning review (#897, its only user), but the question it
// answers is still there. When a night looks wrong, a person can only judge a time the page calls "out of
// bed" by looking at what the camera saw at that moment.
//
// `imagePath` is an API path, not a URL: it is resolved through api.url() here so the short-lived media
// token is attached, as for every other snapshot and clip in the app (a bare <img> cannot send a header).
// The picture stays behind sign-in exactly as before; nothing here makes it reachable without a session.
export default function ImagePreviewModal({ title, imagePath, meta, onClose }) {
  return (
    <Modal title={title} onClose={onClose} wide>
      <img className="image-preview" src={api.url(imagePath)} alt="" />
      {meta ? <div className="clip-player__meta">{meta}</div> : null}
    </Modal>
  );
}
