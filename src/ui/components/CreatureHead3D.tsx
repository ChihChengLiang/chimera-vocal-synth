/**
 * A creature's head on the duet page: the recorded telemetry replayed on a 3D model (`Buffalo3D`),
 * in the look of the human heads: three.js draws into its own canvas, which is copied into this
 * one and given the same glow pass.
 */
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { Buffalo3D } from "../render/buffalo3d.ts";
import { Glow } from "../render/vector.ts";
import type { CreatureTrack } from "../../show/ctele.ts";
import type { Clock } from "../../show/clock.ts";

export function CreatureHead3D(props: { track: CreatureTrack; transport: Clock; facing: 1 | -1 }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const { track, transport, facing } = props;

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    const wrap = wrapRef.current!;
    const glCanvas = document.createElement("canvas");
    let gl: THREE.WebGLRenderer;
    try {
      gl = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: true, alpha: false, powerPreference: "high-performance" });
    } catch {
      setFailed(true);
      return;
    }
    gl.outputColorSpace = THREE.LinearSRGBColorSpace;
    gl.setClearColor(0x000000, 1);
    const head = new Buffalo3D();
    head.facing = facing;
    const glow = new Glow();
    let w = 0, h = 0, dpr = 1;
    const fit = () => {
      const b = wrap.getBoundingClientRect();
      dpr = Math.min(1.5, window.devicePixelRatio || 1);
      w = b.width;
      h = b.height;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      gl.setPixelRatio(dpr);
      gl.setSize(Math.max(1, w), Math.max(1, h), false);
      head.resize(Math.max(1, w), Math.max(1, h));
    };
    const ro = new ResizeObserver(fit);
    ro.observe(wrap);
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (w > 0 && h > 0) {
        // paused, the head comes to rest; playing, it follows the recording at the playhead
        head.update(transport.isPlaying ? track.frame(track.indexAt(transport.time())) : null, dt);
        gl.render(head.scene, head.camera);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalCompositeOperation = "source-over";
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(glCanvas, 0, 0, canvas.width, canvas.height);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        glow.apply(canvas, ctx, dpr);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      head.dispose();
      gl.dispose();
      gl.forceContextLoss();
    };
  }, [track, transport, facing]);

  if (failed)
    return (
      <div className="anatomy three">
        <p className="no-webgl">3D needs WebGL, which this browser has turned off.</p>
      </div>
    );
  return (
    <div ref={wrapRef} className="anatomy three">
      <canvas ref={canvasRef} aria-label="A water buffalo's head in 3D, moving as it sang" role="img" />
    </div>
  );
}
