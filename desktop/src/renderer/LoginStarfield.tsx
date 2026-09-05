import { useEffect, useRef } from "react";
import "./LoginStarfield.css";

const VERTEX_SHADER = `
  attribute vec2 a_position;
  void main() { gl_Position = vec4(a_position, 0.0, 1.0); }
`;

// Broad, continuous fields: no photograph, fine dust, or high-frequency texture.
const FRAGMENT_SHADER = `
  #ifdef GL_FRAGMENT_PRECISION_HIGH
    precision highp float;
  #else
    precision mediump float;
  #endif
  uniform vec2 u_resolution;
  uniform float u_time;
  uniform vec4 u_pointer;
  uniform vec4 u_trail[4];
  float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  float cloud(vec2 p) {
    // Analytic fields stay continuous across the entire sky, including on integrated GPUs.
    return 0.43 + 0.18 * sin(p.x * 1.2 + p.y * 0.65)
                + 0.10 * sin(p.x * -0.7 + p.y * 1.6 + 1.4)
                + 0.06 * sin(p.x * 1.9 - p.y * 1.1 + 2.6);
  }
  void main() {
    vec2 uv = gl_FragCoord.xy / u_resolution;
    float aspect = u_resolution.x / u_resolution.y;
    vec2 p = vec2(uv.x * aspect, uv.y);
    vec2 delta = p - vec2(u_pointer.x * aspect, u_pointer.y);
    float distanceToPointer = length(delta);
    float presence = exp(-dot(delta, delta) * 12.0) * u_pointer.z;
    // The cursor reshapes just the clouds beneath it. A broad pulse persists while
    // hovering; four fading wake samples preserve the path of a pointer gesture.
    float pulse = sin(distanceToPointer * 16.0 - u_time * 1.9);
    p += delta * presence * (0.33 + pulse * 0.13 + u_pointer.w * 0.2);
    p += vec2(-delta.y, delta.x) * presence * 0.14;
    float wakeLight = 0.0;
    for (int i = 0; i < 4; i++) {
      vec4 wake = u_trail[i];
      vec2 offset = p - vec2(wake.x * aspect, wake.y);
      float radius = length(offset);
      float envelope = exp(-radius * radius * 10.0 - wake.z * 0.95) * wake.w;
      float wave = sin(radius * 14.0 - wake.z * 2.3);
      p += offset * wave * envelope * 0.17;
      wakeLight += envelope * (0.5 + wave * 0.5) * 0.025;
    }
    float t = u_time * 0.025;
    vec2 drift = vec2(t * 0.18, -t * 0.1);
    vec2 warp = vec2(cloud(p * 1.18 + drift + 2.4), cloud(p * 1.08 - drift + 8.6));
    float mist = cloud(p * 1.7 + warp * 1.25 + vec2(t * 0.1, 0.0));
    // A single sweeping cloud bank gives depth, leaving generous quiet space.
    float bankDistance = (p.y - 0.5 - sin(p.x * 1.45 - 0.65) * 0.24
                         - (mist - 0.45) * 0.48) * 2.85;
    float bank = exp(-bankDistance * bankDistance);
    float blend = smoothstep(-0.1, 1.05, uv.x + (mist - 0.42) * 0.34);
    vec3 indigo = vec3(0.115, 0.195, 0.365);
    vec3 lilac = vec3(0.445, 0.465, 0.685);
    vec3 rose = vec3(0.765, 0.515, 0.625);
    vec3 color = mix(indigo, lilac, smoothstep(0.0, 0.66, blend));
    color = mix(color, rose, smoothstep(0.42, 1.0, blend));
    vec3 cloudColor = mix(vec3(0.515, 0.64, 0.85), vec3(0.91, 0.735, 0.80), blend);
    color = mix(color, cloudColor, bank * smoothstep(0.18, 0.76, mist) * 0.54);
    color += (mist - 0.42) * 0.11;
    color += vec3(0.12, 0.145, 0.175) * presence * (0.6 + pulse * 0.15);
    float rippleDistance = (distanceToPointer - 0.18 - sin(u_time * 1.2) * 0.035) / 0.065;
    float ripple = exp(-rippleDistance * rippleDistance) * u_pointer.z;
    color = mix(color, cloudColor, ripple * 0.12);
    color += vec3(0.65, 0.72, 0.86) * wakeLight;
    // Sixteen tiny, widely spaced stars; their positions are stable across frames.
    for (int i = 0; i < 16; i++) {
      float index = float(i);
      vec2 star = vec2(hash(vec2(index, 13.0)), hash(vec2(index, 47.0)));
      float d = length((uv - star) * u_resolution);
      float shimmer = 0.8 + sin(u_time * 0.32 + index) * 0.12;
      color += vec3(0.55, 0.6, 0.69) * (1.0 - smoothstep(0.1, 1.1, d)) * shimmer * 0.34;
    }
    color *= 0.93 + smoothstep(0.0, 0.48, uv.y) * 0.07;
    gl_FragColor = vec4(color, 1.0);
  }
`;

type SkyRenderer = {
  draw: (time: number, pointer: Float32Array, trail: Float32Array) => void;
  dispose: () => void;
};

function createSkyRenderer(canvas: HTMLCanvasElement): SkyRenderer | null {
  const gl = canvas.getContext("webgl", {
    alpha: false, antialias: false, depth: false, powerPreference: "low-power",
  });
  if (!gl) return null;
  const shaders: WebGLShader[] = [];
  let program: WebGLProgram | null = null;
  let buffer: WebGLBuffer | null = null;
  const dispose = () => {
    if (buffer) gl.deleteBuffer(buffer);
    if (program) gl.deleteProgram(program);
    shaders.forEach((shader) => gl.deleteShader(shader));
  };
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type);
    if (!shader) throw new Error("The login background shader is unavailable.");
    shaders.push(shader);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error("The login background shader could not compile.");
    return shader;
  };
  try {
    program = gl.createProgram();
    if (!program) throw new Error("The login background program is unavailable.");
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX_SHADER));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error("The login background program could not link.");
    gl.useProgram(program);
    buffer = gl.createBuffer();
    if (!buffer) throw new Error("The login background buffer is unavailable.");
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, "a_position");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    const resolution = gl.getUniformLocation(program, "u_resolution");
    const time = gl.getUniformLocation(program, "u_time");
    const pointer = gl.getUniformLocation(program, "u_pointer");
    const trail = gl.getUniformLocation(program, "u_trail[0]");
    return {
      draw: (elapsed, pointerValues, trailValues) => {
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.uniform2f(resolution, canvas.width, canvas.height);
        gl.uniform1f(time, elapsed);
        gl.uniform4fv(pointer, pointerValues);
        gl.uniform4fv(trail, trailValues);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      },
      dispose,
    };
  } catch {
    dispose();
    return null;
  }
}

/** A locally rendered, quiet sky. Pointer gestures reshape clouds instead of moving a picture. */
export function LoginStarfield() {
  const fieldRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const field = fieldRef.current;
    if (!canvas || !field) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let renderer = createSkyRenderer(canvas);
    field.dataset.renderer = renderer ? "webgl" : "fallback";
    let frame = 0;
    let lastTime = 0;
    let elapsed = 0;
    let disposed = false;
    let width = 1;
    let height = 1;
    let lastWakeAt = 0;
    const pointer = { x: 0.5, y: 0.5, targetX: 0.5, targetY: 0.5, strength: 0, speed: 0, active: false };
    const wakes: { x: number; y: number; age: number; strength: number }[] = [];
    const pointerValues = new Float32Array(4);
    const trailValues = new Float32Array(16);

    const paint = (time: number) => {
      frame = 0;
      if (disposed || document.hidden) return;
      if (!reducedMotion.matches && lastTime && time - lastTime < 1000 / 30) {
        frame = window.requestAnimationFrame(paint);
        return;
      }
      const dt = lastTime ? Math.min((time - lastTime) / 1000, 0.1) : 0;
      lastTime = time;
      if (!reducedMotion.matches) elapsed += dt;
      const smoothing = 1 - Math.exp(-dt * 8);
      pointer.x += (pointer.targetX - pointer.x) * smoothing;
      pointer.y += (pointer.targetY - pointer.y) * smoothing;
      pointer.strength += ((pointer.active ? 1 : 0) - pointer.strength) * smoothing;
      pointer.speed *= Math.exp(-dt * 3.5);
      pointerValues.set([pointer.x, 1 - pointer.y, pointer.strength, pointer.speed]);
      trailValues.fill(0);
      wakes.forEach((wake, index) => {
        wake.age += dt;
        trailValues.set([wake.x, 1 - wake.y, wake.age, wake.strength], index * 4);
      });
      field.style.setProperty("--nebula-pointer-x", `${(pointer.x * 100).toFixed(2)}%`);
      field.style.setProperty("--nebula-pointer-y", `${(pointer.y * 100).toFixed(2)}%`);
      field.style.setProperty("--nebula-pointer-strength", pointer.strength.toFixed(3));
      renderer?.draw(elapsed, pointerValues, trailValues);
      if (!reducedMotion.matches) frame = window.requestAnimationFrame(paint);
    };
    const schedule = () => {
      if (!frame && !disposed && !document.hidden) frame = window.requestAnimationFrame(paint);
    };
    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      width = Math.max(1, bounds.width);
      height = Math.max(1, bounds.height);
      // Soft clouds do not need a Retina framebuffer. Bound both axes on large screens.
      const ratio = Math.min(window.devicePixelRatio || 1, 1.5, 1280 / width, 900 / height);
      const nextWidth = Math.max(1, Math.round(width * ratio));
      const nextHeight = Math.max(1, Math.round(height * ratio));
      if (canvas.width !== nextWidth || canvas.height !== nextHeight) {
        canvas.width = nextWidth;
        canvas.height = nextHeight;
      }
      schedule();
    };
    const move = (event: PointerEvent) => {
      if (reducedMotion.matches || event.pointerType === "touch") return;
      const bounds = canvas.getBoundingClientRect();
      const x = (event.clientX - bounds.left) / width;
      const y = (event.clientY - bounds.top) / height;
      pointer.active = x >= 0 && x <= 1 && y >= 0 && y <= 1;
      if (!pointer.active) return;
      const distance = Math.hypot((x - pointer.targetX) * width / height, y - pointer.targetY);
      pointer.speed = Math.min(1, pointer.speed + distance * 9);
      pointer.targetX = x;
      pointer.targetY = y;
      const now = performance.now();
      const previousWake = wakes[0];
      if (now - lastWakeAt > 110 && (!previousWake || Math.hypot(x - previousWake.x, y - previousWake.y) > 0.035)) {
        wakes.unshift({ x, y, age: 0, strength: Math.min(0.8, 0.24 + pointer.speed * 0.55) });
        wakes.length = Math.min(wakes.length, 4);
        lastWakeAt = now;
      }
      schedule();
    };
    const leave = () => { pointer.active = false; };
    const updatePlayback = () => {
      window.cancelAnimationFrame(frame);
      frame = 0;
      lastTime = 0;
      field.dataset.paused = String(document.hidden);
      if (reducedMotion.matches) {
        pointer.strength = 0;
        pointer.speed = 0;
        pointer.active = false;
        wakes.length = 0;
      }
      schedule();
    };
    const contextLost = (event: Event) => {
      event.preventDefault();
      renderer = null;
      field.dataset.renderer = "fallback";
    };
    const contextRestored = () => {
      renderer = createSkyRenderer(canvas);
      field.dataset.renderer = renderer ? "webgl" : "fallback";
      schedule();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    canvas.addEventListener("webglcontextlost", contextLost);
    canvas.addEventListener("webglcontextrestored", contextRestored);
    window.addEventListener("pointermove", move, { passive: true });
    document.documentElement.addEventListener("pointerleave", leave);
    window.addEventListener("blur", leave);
    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", updatePlayback);
    reducedMotion.addEventListener("change", updatePlayback);
    resize();
    updatePlayback();
    return () => {
      disposed = true;
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      renderer?.dispose();
      canvas.removeEventListener("webglcontextlost", contextLost);
      canvas.removeEventListener("webglcontextrestored", contextRestored);
      window.removeEventListener("pointermove", move);
      document.documentElement.removeEventListener("pointerleave", leave);
      window.removeEventListener("blur", leave);
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", updatePlayback);
      reducedMotion.removeEventListener("change", updatePlayback);
    };
  }, []);

  return (
    <div ref={fieldRef} className="login-starfield" aria-hidden="true">
      <div className="login-starfield__fallback" />
      <canvas ref={canvasRef} className="login-starfield__canvas" />
    </div>
  );
}
