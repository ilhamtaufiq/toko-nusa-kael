import { useEffect, useRef } from 'react';
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
// Resolusi setinggi yang didukung kamera: browser memilih yang terbesar yang tersedia
const VIDEO: MediaTrackConstraints = {
  facingMode: { ideal: 'environment' },
  width: { ideal: 4096 },
  height: { ideal: 2160 },
};
const CAMERA_ERROR = 'Kamera tidak bisa dibuka. Izinkan akses kamera, atau pakai scanner USB.';

/** Minta fokus terus-menerus bila perangkat mendukung. Yang tidak didukung dilewati tanpa error. */
async function tuneFocus(stream: MediaStream): Promise<string> {
  const track = stream.getVideoTracks()[0];
  if (!track) return 'kamera tidak ditemukan';
  const caps = (track.getCapabilities?.() ?? {}) as {
    focusMode?: string[];
    width?: { max?: number };
    height?: { max?: number };
  };
  // Naikkan ke resolusi maksimum yang dilaporkan kamera
  if (caps.width?.max && caps.height?.max) {
    await track.applyConstraints({ width: caps.width.max, height: caps.height.max }).catch(() => {});
  }
  let focus = 'tidak didukung';
  if (caps.focusMode?.includes('continuous')) {
    await track.applyConstraints({ advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet] }).catch(() => {});
    focus = 'kontinu';
  }
  const s = track.getSettings?.();
  return `fokus ${focus}, ${s?.width ?? '?'}x${s?.height ?? '?'}`;
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
    let last = '';
    let lastAt = 0;

    const emit = (raw: string) => {
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
          stream = await navigator.mediaDevices.getUserMedia({ video: VIDEO, audio: false });
        } catch {
          return fail();
        }
        if (!alive) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        // Minta fokus terus-menerus, supaya barcode tetap tajam saat kamera digerakkan.
        // Tidak semua HP mendukungnya; yang tidak didukung dilewati.
        setFocusInfo(await tuneFocus(stream));
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
          stream = await navigator.mediaDevices.getUserMedia({ video: VIDEO, audio: false });
        } catch {
          return fail();
        }
        if (!alive) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        setFocusInfo(await tuneFocus(stream));
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
