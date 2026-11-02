import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { setupApi } from '../lib/setupApi.js';
import { useCameras } from '../lib/CamerasContext.jsx';
import CameraForm from '../components/CameraForm.jsx';
import CameraTile from '../components/CameraTile.jsx';
import SetupStepShell from '../components/SetupStepShell.jsx';

const STEPS = ['welcome', 'children', 'camera', 'monitor_test', 'review'];
const terminal = (status) => ['legacy_completed', 'completed_limited', 'completed'].includes(status);
const publish = (state) => window.dispatchEvent(new CustomEvent('setup-state-changed', { detail: state }));

export default function Setup() {
  const navigate = useNavigate();
  const { kids, cameras, loaded: camerasLoaded, error: camerasError, refresh } = useCameras();
  const [setup, setSetup] = useState(null);
  const [step, setStep] = useState('welcome');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [childName, setChildName] = useState('');
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
      const child = await api.post('/children', { name: childName.trim() });
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
      setError(err.data?.missing?.length ? 'A child, assigned camera and picture check are needed. Try the missing step, or continue with limited setup.' : err.message);
    } finally { setBusy(false); }
  }

  if (!setup) return <main className="app-main">{error ? <div className="error-banner" role="alert">{error} <button className="btn" onClick={load}>Try again</button></div> : 'Loading setup…'}</main>;
  // WHY: the provider fetches children and cameras beside setup. An empty list before
  // that fetch settles is not evidence that the household has no children or cameras.
  if (!camerasLoaded || camerasError) return <main className="app-main">
    {camerasError ? <div className="error-banner" role="alert">Could not load children and cameras: {camerasError} <button className="btn" type="button" onClick={refresh}>Try again</button></div> : 'Loading children and cameras…'}
  </main>;
  const assigned = cameras.filter((camera) => camera.child_id && !camera.disabled);
  const camera = assigned.find((item) => item.id === selectedCamera);
  const reviewOnly = setup.status === 'legacy_completed' || setup.status === 'completed';
  const back = step === 'welcome' || (step === 'review' && terminal(setup.status))
    ? null : () => move(terminal(setup.status) ? 'review' : STEPS[STEPS.indexOf(step) - 1]);
  const canFinishFull = verified || setup.readiness.ready;

  return (
    <SetupStepShell step={step} error={error} busy={busy} onBack={back} onExit={saveAndExit} onRetry={load}>
      {step === 'welcome' && <>
        <p>Add a child and camera, then check that this browser shows a picture. You can leave and finish later.</p>
        <button className="btn btn-primary" type="button" disabled={busy} onClick={() => move('children')}>Get started</button>
      </>}
      {step === 'children' && <>
        {kids.length > 0 && <>
          <p>Choose the child who will use this camera.</p>
          <div className="field"><label htmlFor="setup-child">Child</label>
            <select id="setup-child" value={selectedChild} onChange={(event) => setSelectedChild(event.target.value)}>
              {kids.map((child) => <option key={child.id} value={child.id}>{child.name}</option>)}
            </select></div>
          <button className="btn btn-primary" type="button" disabled={busy || !selectedChild} onClick={() => move('camera')}>Continue</button>
        </>}
        {kids.length === 0 && <form onSubmit={addChild}>
          <p>Add the first child to group their camera and alerts.</p>
          <div className="field"><label htmlFor="setup-child-name">Child's name</label>
            <input id="setup-child-name" required value={childName} onChange={(event) => setChildName(event.target.value)} /></div>
          <button className="btn btn-primary" type="submit" disabled={busy || !childName.trim()}>{busy ? 'Adding…' : 'Add child'}</button>
        </form>}
      </>}
      {step === 'camera' && <>
        {assigned.length > 0 && <>
          <p>Choose an assigned camera, or add another one below.</p>
          <div className="field"><label htmlFor="setup-camera">Camera</label>
            <select id="setup-camera" value={selectedCamera} onChange={(event) => setSelectedCamera(event.target.value)}>
              {assigned.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select></div>
          <button className="btn btn-primary" type="button" disabled={busy || !selectedCamera} onClick={() => move('monitor_test')}>Check picture</button>
        </>}
        {assigned.length === 0 && <CameraForm embedded initialChildId={selectedChild || kids[0]?.id} onCreated={addedCamera} />}
      </>}
      {step === 'monitor_test' && <>
        <p>This checks whether video frames reach this browser. It does not measure the server or guarantee the camera will stay available.</p>
        <div className="field"><label htmlFor="setup-test-camera">Camera to check</label>
          <select id="setup-test-camera" value={selectedCamera} onChange={(event) => { testRef.current = null; setTestId(null); setSelectedCamera(event.target.value); }}>
            {assigned.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select></div>
        <button className="btn btn-primary" type="button" disabled={busy || !camera} onClick={startTest}>Start picture check</button>
        {testId && camera && <div className="setup-player"><CameraTile key={camera.id} camera={camera} frameTestId={testId} onFrames={onFrames} /></div>}
        {testId && !verified && <p role="status">Waiting for the picture to move in this browser…</p>}
        {verified && <p role="status">Picture check passed on this browser.</p>}
        {verified && <button className="btn btn-primary" type="button" disabled={busy} onClick={() => move('review')}>Continue</button>}
        {!verified && <>
          <p>If the camera connects but shows no picture, check its stream path and login in Cameras, then try again.</p>
          <button className="btn btn-secondary" type="button" disabled={busy} onClick={() => { setLimited(true); move('review'); }}>Continue with limited setup</button>
        </>}
      </>}
      {step === 'review' && <>
        <p>{verified ? 'The picture moved in this browser.' : 'You can return to the picture check at any time.'}</p>
        {setup.status === 'completed' ? <p>Setup is complete.</p> : <>
          <p>Child: {setup.readiness.hasChild ? 'added' : 'still needed'}. Camera: {setup.readiness.cameraAssigned ? 'assigned' : 'still needed'}.</p>
          {canFinishFull && <button className="btn btn-primary" type="button" disabled={busy} onClick={finish}>{busy ? 'Finishing…' : 'Finish setup'}</button>}
          {!canFinishFull && limited && !reviewOnly && setup.status !== 'completed_limited' &&
            <button className="btn btn-primary" type="button" disabled={busy} onClick={finish}>{busy ? 'Finishing…' : 'Finish with limited setup'}</button>}
          {!canFinishFull && !limited && !reviewOnly && setup.status !== 'completed_limited' &&
            <button className="btn btn-secondary" type="button" onClick={() => setLimited(true)}>Continue with limited setup</button>}
          {(reviewOnly || setup.status === 'completed_limited') && !canFinishFull &&
            <button className="btn btn-primary" type="button" onClick={() => move('monitor_test')}>Run picture check</button>}
          {setup.status === 'completed_limited' && canFinishFull &&
            <button className="btn btn-secondary" type="button" onClick={() => move('monitor_test')}>Run picture check again</button>}
        </>}
      </>}
    </SetupStepShell>
  );
}
