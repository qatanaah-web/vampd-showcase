# Live chart motion

The market chart is the product's heartbeat. The goal was a chart that is always moving and never jumps, even though prices arrive irregularly: from one per second to one every few seconds, sometimes revised, sometimes late.

## Design

- **Continuous time.** The x-axis scrolls with the wall clock every frame, not every tick.
- **The head rides behind the feed.** The live dot follows the real line slightly less than one sample behind the newest data, so it is always travelling toward a known point. A naive chart waits at the last point and then jumps when a new one arrives.
- **Data is never redrawn.** The real samples `(T, V)` are never altered. The drawn values `D` each spring to their real value. Settled history is exactly the data; only the newest edge animates.
- **A critically damped spring, integrated exactly.** For displacement `e = x − target`, velocity `v`, stiffness `ω` and frame time `dt`:

  ```ts
  const spring = (x, v, to, w, dt) => {
    const e = x - to, tmp = (v + w * e) * dt, ex = Math.exp(-w * dt);
    return [to + (e + tmp) * ex, (v - w * tmp) * ex];
  };
  ```

  This is the closed-form solution, not an Euler step. A dropped frame or a 120 Hz display gives the same curve, and it never overshoots: a price line that rings past its value would be lying.
- **The y-scale rarely moves.** It changes only when the line nears an edge or leaves much of the plot empty, and then it moves as a spring too. Hairlines sit on the pixel grid when the scale is at rest and glide while it moves.
- **Color carries the bet.** The line and fill are green above the line to beat and red below, blended across the crossover.
- **Cheap when nobody's watching.** The loop pauses off-screen (IntersectionObserver) and in hidden tabs. Mini charts on cards skip frames when nothing changed. With reduced motion, nothing animates but values still update.
- **Spike guard upstream.** The engine holds a tick that jumps more than 3% until the next tick confirms it, so a sandwiched trade never reaches the chart or the settle price.

## Measurement

The numbers come from a headless Chrome harness on the market page, fed real data, recording the head's position every frame (600 frames):

| Metric | Old chart | New chart |
|---|---|---|
| Worst frame-to-frame jerk of the head | 1.49 px | 0.21 px |
| Largest single step | 1.49 px | 0.81 px |
| Frames where the head stood still | 6 | 0 |
| JS per frame, p50 / p95 / max | 0.6 / 0.7 / 1.3 ms | 0.2 / 0.3 / 0.5 ms |
| Frame interval p95 | 16.7 ms | 16.8 ms |

On a phone profile with the CPU throttled 4x, it holds 56.5 fps. [`media/chart-stress-old-vs-new.mp4`](../media/chart-stress-old-vs-new.mp4) shows both charts on the same stressed feed.

Source: [`src/ui/LiveChart.tsx`](../src/ui/LiveChart.tsx).
