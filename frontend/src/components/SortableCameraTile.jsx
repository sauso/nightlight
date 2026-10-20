import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import CameraTile from './CameraTile.jsx';

// `sortable` is true for every signed-in user since #675 (it was false for a caregiver while reordering was
// admin-only, #552); the server refuses a non-admin's drop only when it would change the camera a tracked
// child is measured from, and LiveMonitor puts the tiles back. When false (nobody signed in) the sortable is
// disabled AND the tile gets no drag handle, so there is nothing to grab and no drag can start. The tile
// stays inside the same SortableContext either way, so the grid's layout does not depend on it.
export default function SortableCameraTile({ camera, childName, refreshNonce, sortable = true }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: camera.id,
    disabled: !sortable,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} className="sortable-camera-tile">
      <CameraTile
        camera={camera}
        childName={childName}
        dragHandleProps={sortable ? { ...attributes, ...listeners } : undefined}
        refreshNonce={refreshNonce}
      />
    </div>
  );
}
