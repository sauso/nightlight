// UI consistency (PR-C): dialog actions share one equal-width row, including a full-width lone action.
export default function ModalActions({ children }) {
  return <div className="modal-actions">{children}</div>;
}
