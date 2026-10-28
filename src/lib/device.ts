export function isLightDevice() {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };
  const memory = nav.deviceMemory;
  const cores = nav.hardwareConcurrency ?? 8;
  const saveData = nav.connection?.saveData === true;
  return saveData || (memory != null && memory <= 2) || cores <= 2;
}
