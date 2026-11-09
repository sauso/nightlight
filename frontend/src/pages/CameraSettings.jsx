import { useLocation, useNavigate, useParams } from 'react-router-dom';
import AppHeader from '../components/AppHeader.jsx';
import AddCameraFlow from '../components/AddCameraFlow.jsx';
import CameraForm from '../components/CameraForm.jsx';

// /cameras/new is the Add camera screen: search, one card per camera found, the login card, and the manual card
// (#950). /cameras/:id edits a camera with the full form, unchanged. The split lives here, not in CameraForm,
// because AddCameraFlow renders CameraForm (as its manual card) and CameraForm importing it back would be a cycle.
export default function CameraSettings() {
  const { id } = useParams();
  if (!id || id === 'new') return <AddCamera />;
  return <CameraForm />;
}

function AddCamera() {
  const navigate = useNavigate();
  const location = useLocation();
  // Same Back target and landing rule as the full form (#383): a camera opened from the Cameras tab goes back there.
  const back = location.state?.from || { to: '/cameras', label: 'Cameras' };
  return (
    <>
      <AppHeader title="Add camera" back={back} />
      <main className="app-main">
        {/* A new camera lands on its own page: motion, sound and the bed zone are configured from there. */}
        <AddCameraFlow onCreated={(saved) => navigate(`/cameras/${saved.id}`, { state: { from: back } })} />
      </main>
    </>
  );
}
