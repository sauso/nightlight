import Modal from './Modal.jsx';

// #554/#1076: the list and edit screen must describe the same permanent deletion.
export default function RemoveCameraDialog({ camera, error, busy, onClose, onConfirm }) {
  return (
    <Modal title="Remove camera" placement="top" error={error} onClose={() => { if (!busy) onClose(); }}>
      <p style={{ marginTop: 0 }}>
        Remove <strong>{camera.name}</strong>? This stops its stream and permanently deletes everything for this camera:
      </p>
      <ul style={{ margin: '0 0 12px', paddingLeft: 20 }}>
        <li>bed transitions and their snapshot photos</li>
        <li>the activity history it recorded</li>
        <li>alerts, with their clips and snapshots</li>
        <li>recordings and wake clips, including the video files</li>
        <li>its event log and temperature and humidity history</li>
      </ul>
      <p>
        Nights it recorded keep their saved summary and their timelapse but lose their detail and their
        morning-review photos.
      </p>
      <p>You can add the camera again, but none of this comes back. <strong>Are you sure?</strong></p>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button className="btn" type="button" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn btn-danger" type="button" onClick={onConfirm} disabled={busy}>
          {busy ? 'Removing…' : 'Remove'}
        </button>
      </div>
    </Modal>
  );
}
