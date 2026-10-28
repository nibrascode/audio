import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Session } from "@/lib/mix";
import type { SoundTone } from "@/lib/tone";

export type Chapter = { at: number; name: string };

export type ProjectMeta = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  durationMs: number;
  mimeType: string;
  byteSize: number;
  source: "record" | "import";
  note: string;
  peaks: number[];
  tone?: SoundTone;
  marks?: number[];
  parentId?: string;
  chapters?: Chapter[];
};

export type Note = {
  id: string;
  body: string;
  createdAt: number;
  updatedAt: number;
};

export type NewProject = {
  title: string;
  note: string;
  blob: Blob;
  mimeType: string;
  durationMs: number;
  source: "record" | "import";
  peaks: number[];
  tone?: SoundTone;
  marks?: number[];
  parentId?: string;
  chapters?: Chapter[];
};

type Backend = {
  listProjects: () => Promise<ProjectMeta[]>;
  listNotes: () => Promise<Note[]>;
  putProject: (meta: ProjectMeta, blob: Blob) => Promise<void>;
  patchProject: (id: string, patch: Partial<Pick<ProjectMeta, "title" | "note" | "peaks" | "durationMs" | "chapters">>) => Promise<void>;
  removeProject: (id: string) => Promise<void>;
  getBlob: (id: string) => Promise<Blob | null>;
  putBlob: (id: string, blob: Blob) => Promise<void>;
  getSession: (id: string) => Promise<Session | null>;
  putSession: (session: Session) => Promise<void>;
  putNote: (note: Note) => Promise<void>;
  removeNote: (id: string) => Promise<void>;
};

function uid() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function req<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("aborted"));
  });
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("nibras-audio", 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("projects")) db.createObjectStore("projects", { keyPath: "id" });
      if (!db.objectStoreNames.contains("audio")) db.createObjectStore("audio", { keyPath: "id" });
      if (!db.objectStoreNames.contains("notes")) db.createObjectStore("notes", { keyPath: "id" });
      if (!db.objectStoreNames.contains("sessions")) db.createObjectStore("sessions", { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function createIdbBackend(db: IDBDatabase): Backend {
  return {
    async listProjects() {
      const rows = await req(db.transaction("projects", "readonly").objectStore("projects").getAll());
      return rows as ProjectMeta[];
    },
    async listNotes() {
      const rows = await req(db.transaction("notes", "readonly").objectStore("notes").getAll());
      return rows as Note[];
    },
    async putProject(meta, blob) {
      const tx = db.transaction(["projects", "audio"], "readwrite");
      tx.objectStore("projects").put(meta);
      tx.objectStore("audio").put({ id: meta.id, blob });
      await txDone(tx);
    },
    async patchProject(id, patch) {
      const tx = db.transaction("projects", "readwrite");
      const store = tx.objectStore("projects");
      await new Promise<void>((resolve, reject) => {
        const request = store.get(id);
        request.onsuccess = () => {
          const current = request.result as ProjectMeta | undefined;
          if (current) store.put({ ...current, ...patch, updatedAt: Date.now() });
          resolve();
        };
        request.onerror = () => reject(request.error);
      });
      await txDone(tx);
    },
    async removeProject(id) {
      const session = (await req(db.transaction("sessions", "readonly").objectStore("sessions").get(id))) as Session | undefined;
      const tx = db.transaction(["projects", "audio", "sessions"], "readwrite");
      tx.objectStore("projects").delete(id);
      tx.objectStore("audio").delete(id);
      tx.objectStore("sessions").delete(id);
      for (const clip of session?.clips ?? []) {
        if (clip.audioId.startsWith("clip-")) tx.objectStore("audio").delete(clip.audioId);
      }
      await txDone(tx);
    },
    async getBlob(id) {
      const row = (await req(db.transaction("audio", "readonly").objectStore("audio").get(id))) as
        | { id: string; blob: Blob }
        | undefined;
      return row?.blob ?? null;
    },
    async putBlob(id, blob) {
      const tx = db.transaction("audio", "readwrite");
      tx.objectStore("audio").put({ id, blob });
      await txDone(tx);
    },
    async getSession(id) {
      const row = (await req(db.transaction("sessions", "readonly").objectStore("sessions").get(id))) as Session | undefined;
      return row ?? null;
    },
    async putSession(session) {
      const tx = db.transaction("sessions", "readwrite");
      tx.objectStore("sessions").put(session);
      await txDone(tx);
    },
    async putNote(note) {
      const tx = db.transaction("notes", "readwrite");
      tx.objectStore("notes").put(note);
      await txDone(tx);
    },
    async removeNote(id) {
      const tx = db.transaction("notes", "readwrite");
      tx.objectStore("notes").delete(id);
      await txDone(tx);
    },
  };
}

function createMemoryBackend(): Backend {
  const projects = new Map<string, ProjectMeta>();
  const audio = new Map<string, Blob>();
  const notes = new Map<string, Note>();
  const sessions = new Map<string, Session>();
  return {
    async listProjects() {
      return [...projects.values()];
    },
    async listNotes() {
      return [...notes.values()];
    },
    async putProject(meta, blob) {
      projects.set(meta.id, meta);
      audio.set(meta.id, blob);
    },
    async patchProject(id, patch) {
      const current = projects.get(id);
      if (!current) return;
      projects.set(id, { ...current, ...patch, updatedAt: Date.now() });
    },
    async removeProject(id) {
      const session = sessions.get(id);
      projects.delete(id);
      audio.delete(id);
      sessions.delete(id);
      for (const clip of session?.clips ?? []) {
        if (clip.audioId.startsWith("clip-")) audio.delete(clip.audioId);
      }
    },
    async getBlob(id) {
      return audio.get(id) ?? null;
    },
    async putBlob(id, blob) {
      audio.set(id, blob);
    },
    async getSession(id) {
      return sessions.get(id) ?? null;
    },
    async putSession(session) {
      sessions.set(session.id, session);
    },
    async putNote(note) {
      notes.set(note.id, note);
    },
    async removeNote(id) {
      notes.delete(id);
    },
  };
}

type LibraryValue = {
  ready: boolean;
  memoryOnly: boolean;
  projects: ProjectMeta[];
  notes: Note[];
  addProject: (input: NewProject) => Promise<ProjectMeta>;
  updateProject: (id: string, patch: Partial<Pick<ProjectMeta, "title" | "note" | "peaks" | "durationMs" | "chapters">>) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  getAudio: (id: string) => Promise<Blob | null>;
  putAudio: (id: string, blob: Blob) => Promise<void>;
  getSession: (id: string) => Promise<Session | null>;
  saveSession: (session: Session) => Promise<void>;
  addNote: (body: string) => Promise<void>;
  updateNote: (id: string, body: string) => Promise<void>;
  deleteNote: (id: string) => Promise<void>;
};

const LibraryContext = createContext<LibraryValue | null>(null);

function byRecent<T extends { updatedAt: number }>(rows: T[]) {
  return [...rows].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function LibraryProvider({ children }: { children: ReactNode }) {
  const backendRef = useRef<Backend | null>(null);
  const [ready, setReady] = useState(false);
  const [memoryOnly, setMemoryOnly] = useState(false);
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);

  const refresh = useCallback(async () => {
    const backend = backendRef.current;
    if (!backend) return;
    const [nextProjects, nextNotes] = await Promise.all([backend.listProjects(), backend.listNotes()]);
    setProjects(byRecent(nextProjects));
    setNotes(byRecent(nextNotes));
  }, []);

  useEffect(() => {
    let cancel = false;
    void (async () => {
      try {
        if (typeof indexedDB === "undefined") throw new Error("no idb");
        backendRef.current = createIdbBackend(await openDb());
      } catch {
        backendRef.current = createMemoryBackend();
        if (!cancel) setMemoryOnly(true);
      }
      if (cancel) return;
      await refresh();
      if (!cancel) setReady(true);
    })();
    return () => {
      cancel = true;
    };
  }, [refresh]);

  const notesRef = useRef(notes);
  notesRef.current = notes;

  const addProject = useCallback(
    async (input: NewProject) => {
      const backend = backendRef.current;
      if (!backend) throw new Error("library not ready");
      if (input.blob.size < 16) throw new Error("incomplete");
      const now = Date.now();
      const meta: ProjectMeta = {
        id: uid(),
        title: input.title.trim().slice(0, 80) || "Nibras",
        createdAt: now,
        updatedAt: now,
        durationMs: input.durationMs,
        mimeType: input.mimeType || input.blob.type || "audio/webm",
        byteSize: input.blob.size,
        source: input.source,
        note: input.note.slice(0, 8000),
        peaks: input.peaks,
        tone: input.tone,
        marks: input.marks,
        parentId: input.parentId,
        chapters: input.chapters,
      };
      await backend.putProject(meta, input.blob);
      await refresh();
      return meta;
    },
    [refresh],
  );

  const updateProject = useCallback(
    async (id: string, patch: Partial<Pick<ProjectMeta, "title" | "note" | "peaks" | "durationMs" | "chapters">>) => {
      const backend = backendRef.current;
      if (!backend) throw new Error("library not ready");
      const next = { ...patch };
      if (typeof next.title === "string") next.title = next.title.trim().slice(0, 80);
      if (typeof next.note === "string") next.note = next.note.slice(0, 8000);
      await backend.patchProject(id, next);
      await refresh();
    },
    [refresh],
  );

  const deleteProject = useCallback(
    async (id: string) => {
      const backend = backendRef.current;
      if (!backend) throw new Error("library not ready");
      await backend.removeProject(id);
      await refresh();
    },
    [refresh],
  );

  const getAudio = useCallback((id: string) => {
    const backend = backendRef.current;
    if (!backend) return Promise.resolve(null);
    return backend.getBlob(id);
  }, []);

  const putAudio = useCallback(async (id: string, blob: Blob) => {
    const backend = backendRef.current;
    if (!backend) throw new Error("library not ready");
    if (blob.size < 16) throw new Error("incomplete");
    await backend.putBlob(id, blob);
  }, []);

  const getSession = useCallback((id: string) => {
    const backend = backendRef.current;
    if (!backend) return Promise.resolve(null);
    return backend.getSession(id);
  }, []);

  const saveSession = useCallback(async (session: Session) => {
    const backend = backendRef.current;
    if (!backend) throw new Error("library not ready");
    await backend.putSession(session);
  }, []);

  const addNote = useCallback(
    async (body: string) => {
      const backend = backendRef.current;
      if (!backend) throw new Error("library not ready");
      const now = Date.now();
      await backend.putNote({ id: uid(), body: body.slice(0, 8000), createdAt: now, updatedAt: now });
      await refresh();
    },
    [refresh],
  );

  const updateNote = useCallback(
    async (id: string, body: string) => {
      const backend = backendRef.current;
      if (!backend) throw new Error("library not ready");
      const current = notesRef.current.find((note) => note.id === id);
      if (!current) return;
      await backend.putNote({ ...current, body: body.slice(0, 8000), updatedAt: Date.now() });
      await refresh();
    },
    [refresh],
  );

  const deleteNote = useCallback(
    async (id: string) => {
      const backend = backendRef.current;
      if (!backend) throw new Error("library not ready");
      await backend.removeNote(id);
      await refresh();
    },
    [refresh],
  );

  const value = useMemo<LibraryValue>(
    () => ({
      ready,
      memoryOnly,
      projects,
      notes,
      addProject,
      updateProject,
      deleteProject,
      getAudio,
      putAudio,
      getSession,
      saveSession,
      addNote,
      updateNote,
      deleteNote,
    }),
    [ready, memoryOnly, projects, notes, addProject, updateProject, deleteProject, getAudio, putAudio, getSession, saveSession, addNote, updateNote, deleteNote],
  );

  return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>;
}

export function useLibrary() {
  const value = useContext(LibraryContext);
  if (!value) throw new Error("useLibrary outside provider");
  return value;
}
