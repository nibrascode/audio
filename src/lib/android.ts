type NativeShell = {
  keepAwake?: () => void;
  letSleep?: () => void;
  recording?: (active: boolean) => void;
};

function shell(): NativeShell | null {
  if (typeof window === "undefined") return null;
  const host = (window as Window & { NibrasNative?: NativeShell }).NibrasNative;
  return host ?? null;
}

export function notifyRecording(active: boolean) {
  try {
    shell()?.recording?.(active);
  } catch {
    /* the Android shell is optional */
  }
}

export async function holdScreen() {
  try {
    shell()?.keepAwake?.();
  } catch {
    /* ignore a missing shell */
  }
  try {
    return (await navigator.wakeLock?.request("screen")) ?? null;
  } catch {
    return null;
  }
}

export function releaseScreen(lock: WakeLockSentinel | null) {
  try {
    shell()?.letSleep?.();
  } catch {
    /* ignore a missing shell */
  }
  void lock?.release().catch(() => undefined);
}
