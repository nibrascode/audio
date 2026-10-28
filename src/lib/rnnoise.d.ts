declare module "@jitsi/rnnoise-wasm/dist/rnnoise-sync.js" {
  export default function createRNNWasmModuleSync(): Promise<{
    _rnnoise_create: () => number;
    _rnnoise_destroy: (state: number) => void;
    _rnnoise_process_frame: (state: number, outPtr: number, inPtr: number) => number;
    _malloc: (bytes: number) => number;
    _free: (ptr: number) => void;
    HEAPF32: Float32Array;
  }>;
}
