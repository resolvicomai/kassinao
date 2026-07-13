export const PRIVATE_FILE_UMASK = 0o077;

/** Files default to 0600 and directories to 0700 unless a call is stricter. */
export function enforcePrivateUmask(setUmask: (mask: number) => number = process.umask): number {
  return setUmask(PRIVATE_FILE_UMASK);
}

enforcePrivateUmask();
