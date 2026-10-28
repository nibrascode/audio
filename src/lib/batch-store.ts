export type StoredClip = {
  key: string;
  title: string;
  durationMs: number;
  source: "record" | "import";
  start: number;
  end: number;
  spot: number;
  marks: number[];
  peaks: number[];
  projectId?: string;
  blob?: Blob;
  locked?: boolean;
};

function openDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("nibras-batch", 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("layout")) db.createObjectStore("layout");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveBatch(clips: StoredClip[]) {
  const db = await openDb();
  const tx = db.transaction("layout", "readwrite");
  tx.objectStore("layout").put(clips, "current");
  await new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(null);
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function loadBatch(): Promise<StoredClip[] | null> {
  const db = await openDb();
  const tx = db.transaction("layout", "readonly");
  const clips = await new Promise<StoredClip[] | null>((resolve) => {
    const request = tx.objectStore("layout").get("current");
    request.onsuccess = () => resolve((request.result as StoredClip[] | undefined) ?? null);
    request.onerror = () => resolve(null);
  });
  db.close();
  return clips;
}
