import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { setupApi } from '../lib/setupApi.js';
import { useCameras } from '../lib/CamerasContext.jsx';
import AddCameraFlow from '../components/AddCameraFlow.jsx';
import CameraTile from '../components/CameraTile.jsx';
import SetupStepShell from '../components/SetupStepShell.jsx';
import AppHeader from '../components/AppHeader.jsx';
import TailscaleCard from '../components/TailscaleCard.jsx';

const STEPS = ['welcome', 'children', 'camera', 'monitor_test', 'caregivers', 'remote', 'review'];
const terminal = (status) => ['legacy_completed', 'completed_limited', 'completed'].includes(status);
const normalChrome = (status) => ['legacy_completed', 'completed'].includes(status);
const publish = (state) => window.dispatchEvent(new CustomEvent('setup-state-changed', { detail: state }));

export default function Setup() {
  const navigate = useNavigate();
  const { kids, cameras, loaded: camerasLoaded, error: camerasError, refresh } = useCameras();
  const [setup, setSetup] = useState(null);
  const [step, setStep] = useState('welcome');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [childName, setChildName] = useState('');
  const [birthday, setBirthday] = useState('');
  const [selectedChild, setSelectedChild] = useState('');
  const [selectedCamera, setSelectedCamera] = useState('');
  const [testId, setTestId] = useState(null);
  const [verified, setVerified] = useState(false);
  const [limited, setLimited] = useState(false);
  const [testing, setTesting] = useState(false);
  const mounted = useRef(false);
  const stepRef = useRef(step);
  const testRef = useRef(null);
  stepRef.current = step;

  const load = useCallback(async () => {
    setError('');
    try {
      let current = await setupApi.read();
      if (current.status === 'not_started') {
        current = await setupApi.progress('welcome', current.rowVersion);
        publish(current);
      }
      if (!mounted.current) return;
      setSetup(current);
      const next = terminal(current.status) ? 'review' : current.activeStep;
      setStep(STEPS.includes(next) ? next : 'welcome');
    } catch (err) {
      if (mounted.current) setError(err.message);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    load();
    return () => { mounted.current = false; testRef.current = null; };
  }, [load]);

  useEffect(() => {
    if (kids.length) setSelectedChild((current) => kids.some((child) => child.id === current) ? current : kids[0].id);
    const available = cameras.filter((camera) => camera.child_id && !camera.disabled);
    if (available.length) setSelectedCamera((current) => available.some((camera) => camera.id === current) ? current : available[0].id);
  }, [kids, cameras]);

  async function move(next) {
    testRef.current = null;
    setTestId(null);
    setError('');
    if (terminal(setup.status)) { setStep(next); return true; }
    setBusy(true);
    try {
      const updated = await setupApi.progress(next, setup.rowVersion);
      setSetup(updated);
      setStep(next);
      publish(updated);
      return true;
    } catch (err) {
      if (err.status === 409) {
        await load();
        setError('Setup changed in another tab. The latest step is shown.');
      } else setError(err.message);
      return false;
    } finally { setBusy(false); }
  }

  async function saveAndExit() {
    if (terminal(setup.status)) { navigate('/'); return; }
    // WHY: even an unchanged step is saved with a row version before leaving.
    if (await move(step)) navigate('/');
  }

  async function addChild(event) {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      const child = await api.post('/children', { name: childName.trim(), ...(birthday ? { birthday } : {}) });
      setSelectedChild(child.id);
      await refresh();
      await move('camera');
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  async function addedCamera(camera) {
    setSelectedCamera(camera.id);
    await move('monitor_test');
  }

  async function leaveFor(next, route) {
    if (await move(next)) navigate(route);
  }

  async function startTest() {
    setBusy(true); setError(''); setVerified(false); setTesting(false);
    testRef.current = null;
    setTestId(null);
    try {
      const result = await setupApi.startTest(selectedCamera);
      if (!mounted.current || stepRef.current !== 'monitor_test') return;
      testRef.current = result.testId;
      setTestId(result.testId);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  async function onFrames(id) {
    if (!mounted.current || stepRef.current !== 'monitor_test' || testRef.current !== id || testing) return;
    testRef.current = null; // one confirm, even if both player modes report frames
    setTesting(true);
    try {
      await setupApi.confirm(id, selectedCamera);
      if (!mounted.current || stepRef.current !== 'monitor_test') return;
      setVerified(true);
      setLimited(false);
      setTestId(null);
    } catch (err) { if (mounted.current) setError(`${err.message} Try the picture check again.`); }
    finally { if (mounted.current) setTesting(false); }
  }

  async function finish() {
    setBusy(true); setError('');
    try {
      const result = await setupApi.complete(limited);
      publish(result);
      navigate('/');
    } catch (err) {
      if (err.status === 409) await load();
      if (err.status === 409 && err.data?.code === 'NOT_READY' && err.data.missing?.includes('PLAYBACK')) {
        // WHY: proof lives in server memory and may expire while this review page stays open.
        setVerified(false);
        setLimited(false);
        setError('The picture check has expired. Run it again, or continue with limited setup.');
      } else setError(err.data?.missing?.length ? 'Complete the missing setup steps, or continue with limited setup.' : err.message);
    } finally { setBusy(false); }
  }

  // WHY: until the status is known we cannot tell a finished setup (app chrome) from a wizard in progress.
  // The neutral header keeps a way back to Settings if the read hangs or fails (found in the #947 review).
  if (!setup) return <>
    <AppHeader title="Setup" back={{ to: '/settings', label: 'Settings' }} />
    <SetupStepShell step="review" terminal error={error} onRetry={load}>{!error && 'Loading setup…'}</SetupStepShell>
  </>;
  // WHY: the provider fetches children and cameras beside setup. An empty list before
  // that fetch settles is not evidence that the household has no children or cameras.
  if (!camerasLoaded || camerasError) return <>
    {normalChrome(setup.status) && <AppHeader title="Setup" back={{ to: '/settings', label: 'Settings' }} />}
    <SetupStepShell step={normalChrome(setup.status) ? 'review' : step} terminal={normalChrome(setup.status)} onExit={normalChrome(setup.status) ? null : saveAndExit}>
      {camerasError ? <div className="error-banner" role="alert">Could not load children and cameras: {camerasError} <button className="btn" type="button" onClick={refresh}>Try again</button></div> : 'Loading children and cameras…'}
    </SetupStepShell>
  </>;
  const assigned = cameras.filter((camera) => camera.child_id && !camera.disabled);
  const camera = assigned.find((item) => item.id === selectedCamera);
  const reviewOnly = setup.status === 'legacy_completed' || setup.status === 'completed';
  const back = step === 'welcome' || (step === 'review' && terminal(setup.status))
    ? null : () => move(terminal(setup.status) ? 'review' : STEPS[STEPS.indexOf(step) - 1]);
  const canFinishFull = verified || setup.readiness.ready;
  const reviewChild = kids.find((item) => item.id === selectedChild);
  const primary = step === 'welcome' ? { label: 'Get started', onClick: () => move('children') }
    : step === 'children' ? kids.length
      ? { label: 'Continue', disabled: !selectedChild, onClick: () => move('camera') }
      : { label: busy ? 'Adding…' : 'Continue', disabled: !childName.trim(), form: 'setup-child-form' }
    : step === 'camera' && assigned.length ? { label: 'Check picture', disabled: !selectedCamera, onClick: () => move('monitor_test') }
    : step === 'monitor_test' && verified ? { label: 'Continue', onClick: () => move(terminal(setup.status) ? 'review' : 'caregivers') }
    : step === 'caregivers' ? { label: 'Skip for now', onClick: () => move('remote') }
    : step === 'remote' ? { label: 'Maybe later', onClick: () => move('review') }
    : step === 'review' && setup.status === 'completed'
      ? { label: 'Open my monitor', onClick: () => navigate('/') }
      : step === 'review' && canFinishFull
      ? { label: 'Open my monitor', onClick: finish }
      : step === 'review' && !canFinishFull && limited && !reviewOnly && setup.status !== 'completed_limited'
        ? { label: 'Finish with limited setup', onClick: finish }
        : null;

  return (
    <>
    {normalChrome(setup.status) && <AppHeader title="Setup" back={{ to: '/settings', label: 'Settings' }} />}
    <SetupStepShell step={step} error={error} busy={busy} onBack={back} onExit={normalChrome(setup.status) ? null : saveAndExit} onRetry={load} primary={primary} terminal={normalChrome(setup.status)} subtitle={step === 'review' && canFinishFull && reviewChild ? `Nightlight is ready to monitor ${reviewChild.name}.` : undefined}>
      {step === 'welcome' && <>
        <img className="setup-welcome-icon" src="/icons/icon-192.png" alt="" />
        <ul className="setup-checklist"><li>Add your child</li><li>Connect your camera</li><li>Test your monitor</li><li>Invite caregivers (optional)</li><li>Watch from anywhere (optional)</li></ul>
        <p>You can save your progress and finish later.</p>
      </>}
      {step === 'children' && <>
        {kids.length > 0 && <>
          <p>Choose the child who will use this camera.</p>
          <div className="field"><label htmlFor="setup-child">Child</label>
            <select id="setup-child" value={selectedChild} onChange={(event) => setSelectedChild(event.target.value)}>
              {kids.map((child) => <option key={child.id} value={child.id}>{child.name}</option>)}
            </select></div>
        </>}
        {kids.length === 0 && <form id="setup-child-form" onSubmit={addChild}>
          <p>Add the first child to group their camera and alerts.</p>
          <div className="field"><label htmlFor="setup-child-name">Child's name</label>
            <input id="setup-child-name" required value={childName} onChange={(event) => setChildName(event.target.value)} /></div>
          <div className="field"><label htmlFor="setup-child-birthday">Date of birth (optional)</label>
            <input id="setup-child-birthday" type="date" value={birthday} onChange={(event) => setBirthday(event.target.value)} /></div>
        </form>}
      </>}
      {step === 'camera' && <>
        {assigned.length > 0 && <>
          <p>Choose an assigned camera, or add another one below.</p>
          <div className="field"><label htmlFor="setup-camera">Camera</label>
            <select id="setup-camera" value={selectedCamera} onChange={(event) => setSelectedCamera(event.target.value)}>
              {assigned.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select></div>
        </>}
        <AddCameraFlow autoStart initialChildId={selectedChild || kids[0]?.id} onCreated={addedCamera} />
      </>}
      {step === 'monitor_test' && <>
        <p>This checks whether video frames reach this browser. It does not measure the server or guarantee the camera will stay available.</p>
        <div className="field"><label htmlFor="setup-test-camera">Camera to check</label>
          <select id="setup-test-camera" value={selectedCamera} onChange={(event) => { testRef.current = null; setTestId(null); setSelectedCamera(event.target.value); }}>
            {assigned.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select></div>
        <button className="btn btn-primary" type="button" disabled={busy || !camera} onClick={startTest}>Run picture check</button>
        {testId && camera && <div className="setup-player"><CameraTile key={camera.id} camera={camera} frameTestId={testId} onFrames={onFrames} /></div>}
        {testId && !verified && <p role="status">Waiting for the picture to move in this browser…</p>}
        {verified && <p role="status">Picture check passed on this browser.</p>}
        {!verified && <>
          <p>If the camera connects but shows no picture, check its stream path and login in Cameras, then try again.</p>
          <button className="btn btn-secondary" type="button" disabled={busy} onClick={() => { setLimited(true); move(terminal(setup.status) ? 'review' : 'caregivers'); }}>Continue with limited setup</button>
        </>}
      </>}
      {step === 'caregivers' && <>
        <p>An admin can create caregiver accounts in Settings → Caregivers. Caregivers can view the children and live cameras in this installation.</p>
        <button className="btn btn-secondary" type="button" disabled={busy} onClick={() => leaveFor('remote', '/settings/users/new')}>Add a caregiver account</button>
      </>}
      {step === 'remote' && <>
        <TailscaleCard compact />
      </>}
      {step === 'review' && <>
        <p>{verified ? 'The picture moved in this browser.' : 'You can return to the picture check at any time.'}</p>
        <div className="setup-summary"><div>Child <strong>{reviewChild?.name || (setup.readiness.hasChild ? 'Added' : 'Still needed')}</strong></div>
          <div>Camera <strong>{camera?.name || (setup.readiness.cameraAssigned ? 'Assigned' : 'Still needed')}</strong></div></div>
        {setup.status === 'completed' && <p>Setup is complete.</p>}
        {setup.status !== 'completed' && <>
          <p>Child: {setup.readiness.hasChild ? 'added' : 'still needed'}. Camera: {setup.readiness.cameraAssigned ? 'assigned' : 'still needed'}.</p>
          {!canFinishFull && !limited && !reviewOnly && setup.status !== 'completed_limited' &&
            <button className="btn btn-secondary" type="button" onClick={() => setLimited(true)}>Continue with limited setup</button>}
        </>}
        <button className="btn btn-secondary" type="button" onClick={() => move('monitor_test')}>Run picture check</button>
      </>}
    </SetupStepShell>
    </>
  );
}
