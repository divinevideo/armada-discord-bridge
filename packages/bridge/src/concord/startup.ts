/** Keep the live tail covering traffic that arrives while historical replay is blocked. */
export async function startConcordDelivery(steps: {
  establishFloor: () => Promise<void>;
  installLive: () => void;
  installControl: () => void;
  catchUp: () => Promise<void>;
  onCatchUpError?: (error: unknown) => void;
}): Promise<void> {
  await steps.establishFloor();
  steps.installLive();
  steps.installControl();
  void steps.catchUp().catch(error => {
    if (steps.onCatchUpError) steps.onCatchUpError(error);
    else console.warn("bridge: catch-up incomplete", error);
  });
}
