import { useEffect, useRef, useState } from 'react';
import { BrowserMultiFormatReader } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType } from '@zxing/library';

type Props = {
  onDetect: (code: string) => void;
  onError: (msg: string) => void;
  onClose: () => void;
};

type NativeDetector = { detect: (src: HTMLVideoElement) => Promise<{ rawValue: string }[]> };
type NativeCtor = new (opts: { formats: string[] }) => NativeDetector;

const NATIVE_FORMATS = ['qr_code', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39'];
const ZX_FORMATS = [
  BarcodeFormat.QR_CODE,
  BarcodeFormat.EAN_13,
  BarcodeFormat.EAN_8,
  BarcodeFormat.UPC_A,
  BarcodeFormat.UPC_E,
  BarcodeFormat.CODE_128,
  BarcodeFormat.CODE_39,
];
// Full HD cukup tajam untuk barcode. Resolusi lebih besar membuat kamera gagal tampil di sebagian HP.
const VIDEO: MediaTrackConstraints = {
  facingMode: { ideal: 'environment' },
  width: { ideal: 1920 },
  height: { ideal: 1080 },
};

/** Buka kamera. Kalau pengaturan resolusi ditolak, ulangi dengan pengaturan bawaan kamera. */
async function openCamera(): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({ video: VIDEO, audio: false });
  } catch {
    return await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
  }
}
const CAMERA_ERROR = 'Kamera tidak bisa dibuka. Izinkan akses kamera, atau pakai scanner USB.';

/** Minta fokus terus-menerus bila perangkat mendukung. Yang tidak didukung dilewati tanpa error. */
async function tuneFocus(stream: MediaStream): Promise<string> {
  const track = stream.getVideoTracks()[0];
  if (!track) return 'kamera tidak ditemukan';
  const caps = (track.getCapabilities?.() ?? {}) as { focusMode?: string[] };
  let focus = 'tidak didukung';
  if (caps.focusMode?.includes('continuous')) {
    await track.applyConstraints({ advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet] }).catch(() => {});
    focus = 'kontinu';
  }
  const s = track.getSettings?.();
  return `fokus ${focus}, ${s?.width ?? '?'}x${s?.height ?? '?'}`;
}

/**
 * Auto-zoom bertahap. Bila 2,5 detik tidak ada barcode terbaca, zoom naik satu tingkat (1x, 1,5x, 2x, 3x, lalu kembali).
 * Hanya jalan kalau kamera melaporkan rentang zoom (umumnya Chrome di Android).
 */
function startAutoZoom(stream: MediaStream, lastRead: () => number): { label: string; stop: () => void } {
  const track = stream.getVideoTracks()[0];
  const z = ((track?.getCapabilities?.() ?? {}) as { zoom?: { min: number; max: number } }).zoom;
  if (!track || !z || z.max <= z.min) return { label: 'zoom tidak didukung', stop: () => {} };
  const levels = [1, 1.5, 2, 3]
    .map((v) => Math.min(z.max, Math.max(z.min, v)))
    .filter((v, i, a) => a.indexOf(v) === i);
  let i = 0;
  const timer = window.setInterval(() => {
    if (Date.now() - lastRead() < 2500) return;
    i = (i + 1) % levels.length;
    track.applyConstraints({ advanced: [{ zoom: levels[i] } as MediaTrackConstraintSet] }).catch(() => {});
  }, 2500);
  return { label: `auto-zoom ${z.min}-${z.max}x`, stop: () => window.clearInterval(timer) };
}

/**
 * Pemindai kamera. Memakai BarcodeDetector bila browser mendukung (paling cepat),
 * dan ZXing sebagai cadangan. Kamera hanya bisa dibuka di HTTPS atau localhost.
 */
export default function Scanner({ onDetect, onError, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  // Status fokus kamera, ditampilkan untuk diagnosis di perangkat
  const [focusInfo, setFocusInfo] = useState('memeriksa…');
  // Callback disimpan di ref supaya kamera tidak dinyalakan ulang setiap render
  const cb = useRef({ onDetect, onError });
  cb.current = { onDetect, onError };

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let alive = true;
    let stop = () => {};
    let stopZoom = () => {};
    let last = '';
    let lastAt = 0;
    let lastReadAt = Date.now();

    const emit = (raw: string) => {
      // Terbaca (termasuk kode yang sama): jangan ubah zoom selagi barcode terlihat
      lastReadAt = Date.now();
      // Kode yang sama tidak diproses ulang dalam 1,5 detik
      if (raw === last && Date.now() - lastAt < 1500) return;
      last = raw;
      lastAt = Date.now();
      cb.current.onDetect(raw);
    };
    const fail = () => {
      if (alive) cb.current.onError(CAMERA_ERROR);
    };

    const Native = (window as unknown as { BarcodeDetector?: NativeCtor }).BarcodeDetector;

    if (Native) {
      (async () => {
        let stream: MediaStream;
        try {
          stream = await openCamera();
        } catch {
          return fail();
        }
        if (!alive) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        // Minta fokus terus-menerus, supaya barcode tetap tajam saat kamera digerakkan.
        // Tidak semua HP mendukungnya; yang tidak didukung dilewati.
        const focusLabel = await tuneFocus(stream);
        const az = startAutoZoom(stream, () => lastReadAt);
        stopZoom = az.stop;
        setFocusInfo(`${focusLabel}, ${az.label}`);
        video.srcObject = stream;
        await video.play().catch(() => {});
        const detector = new Native({ formats: NATIVE_FORMATS });
        const timer = window.setInterval(async () => {
          if (!alive || video.readyState < 2) return;
          try {
            const found = await detector.detect(video);
            if (found[0]) emit(found[0].rawValue);
          } catch {
            /* frame belum siap */
          }
        }, 120);
        stop = () => {
          window.clearInterval(timer);
          stream.getTracks().forEach((t) => t.stop());
        };
      })();
    } else {
      // Jalur cadangan (ZXing). Stream dibuka sendiri supaya pengaturan fokus yang sama juga berlaku.
      const hints = new Map<DecodeHintType, unknown>();
      hints.set(DecodeHintType.POSSIBLE_FORMATS, ZX_FORMATS);
      const reader = new BrowserMultiFormatReader(hints);
      (async () => {
        let stream: MediaStream;
        try {
          stream = await openCamera();
        } catch {
          return fail();
        }
        if (!alive) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const focusLabel = await tuneFocus(stream);
        const az = startAutoZoom(stream, () => lastReadAt);
        stopZoom = az.stop;
        setFocusInfo(`${focusLabel}, ${az.label}`);
        try {
          const controls = await reader.decodeFromStream(stream, video, (result) => {
            if (result) emit(result.getText());
          });
          stop = () => {
            controls.stop();
            stream.getTracks().forEach((t) => t.stop());
          };
          if (!alive) stop();
        } catch {
          stream.getTracks().forEach((t) => t.stop());
          fail();
        }
      })();
    }

    return () => {
      alive = false;
      stopZoom();
      stop();
    };
  }, []);

  return (
    <div className="scanner">
      <video ref={videoRef} className="scanner-video" muted playsInline />
      <div className="scanner-bar">
        <span>Arahkan barcode atau QR ke kamera · Kamera: {focusInfo}</span>
        <button type="button" className="btn ghost" onClick={onClose}>
          Tutup kamera
        </button>
      </div>
    </div>
  );
}
