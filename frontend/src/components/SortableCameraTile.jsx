import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import CameraTile from './CameraTile.jsx';

// `sortable` is false for a caregiver (reordering is admin-only, #552, see LiveMonitor): the sortable is
// disabled AND the tile gets no drag handle, so there is nothing to grab and no drag can start. The tile
// stays inside the same SortableContext either way, so the grid's layout does not depend on the role.
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
