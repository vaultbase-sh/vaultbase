/**
 * Animated grid + packet field behind the admin auth screens.
 *
 * Port of the `startBg()` routine in `Vaultbase Setup.dc.html` /
 * `Vaultbase Login.dc.html`: a 48px grid that fades out toward the centre so
 * the card sits on clean ground, with occasional "packets" running along grid
 * lanes. Under prefers-reduced-motion we draw the grid once and skip the
 * packet field entirely rather than animating it at zero speed.
 */
import { useEffect, useRef } from "react";

export default function AuthBackdrop({
  /**
   * Radius of the clean centre, as a fraction of the half-diagonal. The setup
   * board uses 0.35 and the login board 0.4 — the login card is narrower, so
   * its quiet area is proportionally wider.
   */
  clearing = 0.35,
  /** Concurrent packets. Setup draws up to 10, login 9. */
  maxPackets = 10,
}: {
  clearing?: number;
  maxPackets?: number;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduce =
      typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

    const GRID = 48;
    type Packet = { horiz: boolean; dir: number; lane: number; p: number; v: number; hot: boolean };
    let packets: Packet[] = [];
    let raf = 0;
    let last = 0;

    const fadeAt = (px: number, py: number, w: number, h: number) => {
      const d = Math.hypot((px - w / 2) / (w * 0.5), (py - h / 2) / (h * 0.5));
      return Math.min(1, Math.max(0, d - clearing) * 1.8);
    };

    function frame(now: number) {
      const c = ref.current;
      if (!c || !ctx) return;

      const dpr = window.devicePixelRatio || 1;
      const w = c.clientWidth;
      const h = c.clientHeight;
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
        c.width = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const t = now / 1000;
      const dt = Math.min(0.05, t - last);
      last = t;

      const cx = w / 2;
      const cy = h / 2;
      const ox = (w % GRID) / 2;
      const oy = (h % GRID) / 2;

      ctx.lineWidth = 1;
      for (let gx = ox; gx <= w; gx += GRID) {
        ctx.strokeStyle = `rgba(237,235,232,${0.05 * fadeAt(gx, cy, w, h)})`;
        ctx.beginPath();
        ctx.moveTo(gx + 0.5, 0);
        ctx.lineTo(gx + 0.5, h);
        ctx.stroke();
      }
      for (let gy = oy; gy <= h; gy += GRID) {
        ctx.strokeStyle = `rgba(237,235,232,${0.05 * fadeAt(cx, gy, w, h)})`;
        ctx.beginPath();
        ctx.moveTo(0, gy + 0.5);
        ctx.lineTo(w, gy + 0.5);
        ctx.stroke();
      }

      if (reduce) return; // static grid only

      if (packets.length < maxPackets && Math.random() < 0.04) {
        const horiz = Math.random() < 0.6;
        const dir = Math.random() < 0.5 ? 1 : -1;
        const lane = horiz
          ? oy + GRID * Math.floor(Math.random() * (h / GRID))
          : ox + GRID * Math.floor(Math.random() * (w / GRID));
        packets.push({
          horiz,
          dir,
          lane,
          p: dir > 0 ? -120 : (horiz ? w : h) + 120,
          v: 100 + Math.random() * 140,
          hot: Math.random() < 0.3,
        });
      }

      packets = packets.filter((q) => {
        q.p += q.dir * q.v * dt;
        return q.p > -160 && q.p < (q.horiz ? w : h) + 160;
      });

      for (const q of packets) {
        const [x0, y0, x1, y1] = q.horiz
          ? [q.p, q.lane + 0.5, q.p - q.dir * 90, q.lane + 0.5]
          : [q.lane + 0.5, q.p, q.lane + 0.5, q.p - q.dir * 90];
        const f = fadeAt(x0, y0, w, h);
        if (f <= 0) continue;
        const col = q.hot ? "232,90,79" : "237,235,232";
        const grad = ctx.createLinearGradient(x0, y0, x1, y1);
        grad.addColorStop(0, `rgba(${col},${0.7 * f})`);
        grad.addColorStop(1, `rgba(${col},0)`);
        ctx.strokeStyle = grad;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
        ctx.fillStyle = `rgba(${col},${0.9 * f})`;
        ctx.fillRect(x0 - 1.5, y0 - 1.5, 3, 3);
      }
    }

    if (reduce) {
      const draw = () => frame(0);
      draw();
      window.addEventListener("resize", draw);
      return () => window.removeEventListener("resize", draw);
    }

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      frame(now);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [clearing, maxPackets]);

  return <canvas ref={ref} className="vb-auth__bg" aria-hidden="true" />;
}
