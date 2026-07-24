import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import CameraTile from './CameraTile.jsx';

export default function SortableCameraTile({ camera, childName, refreshNonce }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: camera.id,
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
        dragHandleProps={{ ...attributes, ...listeners }}
        refreshNonce={refreshNonce}
      />
    </div>
  );
}
