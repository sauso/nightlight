import { api } from './api.js';

// Keep setup on the shared request path for session expiry, timeouts and 4xx details.
export const setupApi = {
  read: () => api.get('/setup'),
  progress: (activeStep, expectedRowVersion) => api.patch('/setup/progress', { activeStep, expectedRowVersion }),
  startTest: (cameraId) => api.post('/setup/monitor-tests', { cameraId }),
  confirm: (testId, cameraId) => api.post(`/setup/monitor-tests/${testId}/confirm`, { cameraId }),
  complete: (limited) => api.post('/setup/complete', { limited }),
};
