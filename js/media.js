// 录音、照片、画画

const MIMES = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'];
export const MAX_SECONDS = 600;

export async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia || !globalThis.MediaRecorder) throw new Error('这个浏览器不能录音');
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { throw new Error('没有麦克风权限，请在浏览器设置里允许'); }
  const mime = MIMES.find((m) => MediaRecorder.isTypeSupported(m));
  const rec = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: 48000 });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise((ok) => {
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      const type = (rec.mimeType || mime || 'audio/mp4').split(';')[0];
      ok({ kind: 'audio', mime: type, bytes: new Uint8Array(await new Blob(chunks).arrayBuffer()) });
    };
  });
  rec.start(1000);
  return { stop() { if (rec.state !== 'inactive') rec.stop(); return done; } };
}

async function canvasFile(c, kind, mime) {
  const blob = await new Promise((ok) => c.toBlob(ok, mime, 0.85));
  return { kind, mime, bytes: new Uint8Array(await blob.arrayBuffer()) };
}

// 照片统一缩小并重新编码，顺便去掉拍摄地点等信息
export async function loadPhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    try { await img.decode(); } catch { throw new Error('打不开这张照片'); }
    const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k);
    c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return await canvasFile(c, 'photo', 'image/jpeg');
  } finally { URL.revokeObjectURL(url); }
}

export function drawPad(canvas) {
  canvas.width = 1000;
  canvas.height = 700;
  const g = canvas.getContext('2d');
  const clear = () => { g.fillStyle = '#fffdf7'; g.fillRect(0, 0, 1000, 700); pad.used = false; };
  const pos = (e) => { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) * 1000 / r.width, (e.clientY - r.top) * 700 / r.height]; };
  const pad = { color: '#222a3a', used: false, clear, file: () => canvasFile(canvas, 'drawing', 'image/png') };
  let last = null;
  canvas.addEventListener('pointerdown', (e) => {
    last = pos(e);
    try { canvas.setPointerCapture(e.pointerId); } catch { /* 合成事件 */ }
    pad.used = true;
    g.fillStyle = pad.color;
    g.beginPath(); g.arc(last[0], last[1], 5, 0, 7); g.fill();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!last) return;
    const p = pos(e);
    g.strokeStyle = pad.color; g.lineWidth = 10; g.lineCap = 'round';
    g.beginPath(); g.moveTo(...last); g.lineTo(...p); g.stroke();
    last = p;
  });
  for (const t of ['pointerup', 'pointercancel']) canvas.addEventListener(t, () => { last = null; });
  clear();
  return pad;
}
