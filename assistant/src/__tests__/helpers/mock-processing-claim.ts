/** In-memory processing ownership for isolated wake caller fixtures. */
export function mockProcessingClaim() {
  let owner: number | null = null;
  let nextOwner = 0;
  return {
    isProcessing: () => owner !== null,
    waitForIdle: async () => owner === null,
    setProcessing: (on: boolean) => {
      owner = on ? ++nextOwner : null;
    },
    acquireProcessingFenced: async () => {
      if (owner !== null) {
        return null;
      }
      owner = ++nextOwner;
      return owner;
    },
    holdsProcessingClaim: (claim: number) => owner === claim,
    releaseProcessing: (claim: number) => {
      if (owner !== claim) {
        return false;
      }
      owner = null;
      return true;
    },
  };
}
