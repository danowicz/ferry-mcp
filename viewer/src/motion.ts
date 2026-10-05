// Interruptible motion. Every channel is a closed-form damped spring sampled at
// an arbitrary time; retargeting starts the new trajectory from the sampled
// position *and velocity*, so reversing mid-flight never jumps or restarts.

export class Clock {
  speed = 1
  private wallBase = performance.now()
  private sceneBase = 0

  now(): number {
    return this.sceneBase + ((performance.now() - this.wallBase) / 1000) * this.speed
  }

  setSpeed(speed: number) {
    this.sceneBase = this.now()
    this.wallBase = performance.now()
    this.speed = speed
    document.documentElement.style.setProperty('--slow', String(1 / speed))
    for (const animation of document.getAnimations()) animation.playbackRate = speed
  }
}

export interface SpringOptions {
  /** Perceptual duration in seconds. */
  duration?: number
  /** 0 = no overshoot, 0.3 = lively. */
  bounce?: number
  /** Rest threshold in value units. */
  precision?: number
}

interface Pending {
  target: number
  at: number
  options?: SpringOptions
}

export class Spring {
  private x0: number
  private v0 = 0
  private t0 = 0
  private target: number
  private omega = 0
  private zeta = 1
  private precision: number
  private pending: Pending | null = null
  private restAt = 0

  constructor(value: number, options: SpringOptions = {}) {
    this.x0 = value
    this.target = value
    this.precision = options.precision ?? 0.001
    this.configure(options)
  }

  private configure({ duration = 0.5, bounce = 0 }: SpringOptions) {
    this.omega = (2 * Math.PI) / Math.max(0.05, duration)
    this.zeta = 1 - Math.max(-1, Math.min(0.95, bounce))
  }

  get destination(): number {
    return this.pending ? this.pending.target : this.target
  }

  /** Position and velocity of the current trajectory at time t. */
  private trajectory(t: number): [number, number] {
    const dt = Math.max(0, t - this.t0)
    const e0 = this.x0 - this.target
    const { omega: w, zeta: z, v0 } = this
    if (dt === 0) return [this.x0, v0]
    if (Math.abs(z - 1) < 1e-6) {
      const b = v0 + w * e0
      const decay = Math.exp(-w * dt)
      return [this.target + decay * (e0 + b * dt), decay * (b - w * (e0 + b * dt))]
    }
    if (z < 1) {
      const wd = w * Math.sqrt(1 - z * z)
      const b = (v0 + z * w * e0) / wd
      const decay = Math.exp(-z * w * dt)
      const c = Math.cos(wd * dt)
      const s = Math.sin(wd * dt)
      const e = decay * (e0 * c + b * s)
      return [this.target + e, -z * w * e + decay * (-e0 * wd * s + b * wd * c)]
    }
    const root = Math.sqrt(z * z - 1)
    const r1 = -w * (z - root)
    const r2 = -w * (z + root)
    const B = (v0 - r1 * e0) / (r2 - r1)
    const A = e0 - B
    const a = A * Math.exp(r1 * dt)
    const b = B * Math.exp(r2 * dt)
    return [this.target + a + b, r1 * a + r2 * b]
  }

  private flush(t: number) {
    if (this.pending && t >= this.pending.at) {
      const { target, at, options } = this.pending
      this.pending = null
      this.retarget(target, at, options)
    }
  }

  private retarget(target: number, t: number, options?: SpringOptions) {
    const [x, v] = this.sample(t)
    this.x0 = x
    this.v0 = v
    this.t0 = t
    this.target = target
    if (options) this.configure(options)
    this.restAt = 0
  }

  sample(t: number): [number, number] {
    this.flush(t)
    if (this.restAt && t >= this.restAt) return [this.target, 0]
    const [x, v] = this.trajectory(t)
    if (Math.abs(x - this.target) < this.precision && Math.abs(v) < this.precision * 8) {
      this.restAt = t
      return [this.target, 0]
    }
    return [x, v]
  }

  value(t: number): number {
    return this.sample(t)[0]
  }

  /** Head for `target`, optionally after `delay` seconds. Cancels any unstarted move. */
  to(target: number, t: number, options?: SpringOptions & { delay?: number }) {
    this.pending = null
    if (options?.delay) {
      this.pending = { target, at: t + options.delay, options }
      return
    }
    if (target === this.target && !options && this.settled(t)) return
    this.retarget(target, t, options)
  }

  snap(value: number, t: number) {
    this.pending = null
    this.x0 = value
    this.v0 = 0
    this.t0 = t
    this.target = value
    this.restAt = t
  }

  settled(t: number): boolean {
    if (this.pending) return false
    const [x, v] = this.sample(t)
    return x === this.target && v === 0
  }
}
