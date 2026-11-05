/** Keep the live tail covering traffic that arrives while historical replay is blocked. */
export async function startConcordDelivery(steps: {
  establishFloor: () => Promise<void>;
  installLive: () => void;
  installControl: () => void;
  catchUp: () => Promise<void>;
}): Promise<void> {
  await steps.establishFloor();
  steps.installLive();
  steps.installControl();
  await steps.catchUp();
}
