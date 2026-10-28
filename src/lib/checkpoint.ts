export function mergeInt16(parts: Int16Array[]) {
  let total = 0;
  for (const part of parts) total += part.length;
  const merged = new Int16Array(total);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.length;
  }
  return merged;
}

export function flushAfterFrames(sampleRate: number) {
  return Math.max(1, Math.floor(sampleRate / 4));
}

function openDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("nibras-capture", 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("chunks")) db.createObjectStore("chunks", { autoIncrement: true });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
      if (!db.objectStoreNames.contains("pieces")) db.createObjectStore("pieces", { autoIncrement: true });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function done(tx: IDBTransaction) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(null);
    tx.onerror = () => reject(tx.error);
  });
}

export async function clearCapture() {
  const db = await openDb();
  const tx = db.transaction(["chunks", "meta", "pieces"], "readwrite");
  tx.objectStore("chunks").clear();
  tx.objectStore("meta").clear();
  tx.objectStore("pieces").clear();
  await done(tx);
  db.close();
}

export async function pushCapture(sampleRate: number, samples: Int16Array) {
  const db = await openDb();
  const tx = db.transaction(["chunks", "meta"], "readwrite");
  tx.objectStore("meta").put(sampleRate, "rate");
  const copy = new Int16Array(samples.length);
  copy.set(samples);
  tx.objectStore("chunks").put(copy);
  await done(tx);
  db.close();
}

export async function pushCaptureBlob(piece: Blob) {
  if (!piece.size) return;
  const db = await openDb();
  const tx = db.transaction("pieces", "readwrite");
  tx.objectStore("pieces").put(piece);
  await done(tx);
  db.close();
}

export async function readCapture(): Promise<{ sampleRate: number; parts: Int16Array[] } | null> {
  const db = await openDb();
  const tx = db.transaction(["chunks", "meta"], "readonly");
  const rate = await new Promise<number>((resolve) => {
    const request = tx.objectStore("meta").get("rate");
    request.onsuccess = () => resolve(Number(request.result) || 0);
    request.onerror = () => resolve(0);
  });
  const parts = await new Promise<Int16Array[]>((resolve) => {
    const request = tx.objectStore("chunks").getAll();
    request.onsuccess = () => resolve((request.result as Int16Array[]) ?? []);
    request.onerror = () => resolve([]);
  });
  db.close();
  if (!rate || parts.length === 0) return null;
  return { sampleRate: rate, parts };
}

export async function readCaptureBlob(): Promise<Blob | null> {
  const db = await openDb();
  const tx = db.transaction("pieces", "readonly");
  const pieces = await new Promise<Blob[]>((resolve) => {
    const request = tx.objectStore("pieces").getAll();
    request.onsuccess = () => resolve((request.result as Blob[]) ?? []);
    request.onerror = () => resolve([]);
  });
  db.close();
  const kept = pieces.filter((piece) => piece && piece.size > 0);
  if (!kept.length) return null;
  return new Blob(kept, { type: kept[0]?.type || "audio/mp4" });
}
