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
// Resolusi sedang sudah cukup untuk membaca barcode, dan jauh lebih cepat dari resolusi penuh
const VIDEO: MediaTrackConstraints = {
  facingMode: { ideal: 'environment' },
  width: { ideal: 960 },
  height: { ideal: 720 },
};
const CAMERA_ERROR = 'Kamera tidak bisa dibuka. Izinkan akses kamera, atau pakai scanner USB.';

/**
 * Pemindai kamera. Memakai BarcodeDetector bila browser mendukung (paling cepat),
 * dan ZXing sebagai cadangan. Kamera hanya bisa dibuka di HTTPS atau localhost.
 */
export default function Scanner({ onDetect, onError, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
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
      const hints = new Map<DecodeHintType, unknown>();
      hints.set(DecodeHintType.POSSIBLE_FORMATS, ZX_FORMATS);
      const reader = new BrowserMultiFormatReader(hints);
      reader
        .decodeFromConstraints({ video: VIDEO }, video, (result) => {
          if (result) emit(result.getText());
        })
        .then((controls) => {
          if (alive) stop = () => controls.stop();
          else controls.stop();
        })
        .catch(fail);
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
        <span>Arahkan barcode atau QR ke kamera</span>
        <button type="button" className="btn ghost" onClick={onClose}>
          Tutup kamera
        </button>
      </div>
    </div>
  );
}
