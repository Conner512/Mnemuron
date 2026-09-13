// Capture owns dispatch, not Memory: failure or disabling of the continuity path
// must not prevent independently authorized source processing.
export function dispatchCapture({handoffEnabled, processHandoff, memoryEnabled, processMemory}) {
  const checkpoints = handoffEnabled ? processHandoff() : [];
  const structured_memories = memoryEnabled ? processMemory() : {status:'disabled'};
  return {checkpoints,structured_memories};
}
