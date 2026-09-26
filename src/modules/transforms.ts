/**
 * Waveform Viewer Pro - Clarke & Park Transforms
 * Engineering transforms for three-phase motor drive and power electronics analysis.
 */

export interface ClarkeResult {
  alpha: Float32Array;
  beta: Float32Array;
  zero: Float32Array;
}

export interface ParkResult {
  d: Float32Array;
  q: Float32Array;
}

/**
 * Computes standard Clarke Transform:
 *   alpha = (2/3) * Ua - (1/3) * Ub - (1/3) * Uc
 *   beta  = (1 / sqrt(3)) * (Ub - Uc)
 *   zero  = (1/3) * (Ua + Ub + Uc)
 */
export function computeClarke(
  ua: Float32Array,
  ub: Float32Array,
  uc: Float32Array
): ClarkeResult {
  const n = ua.length;
  if (ub.length !== n || uc.length !== n) {
    throw new Error('Phase arrays Ua, Ub, Uc must have identical lengths.');
  }

  const alpha = new Float32Array(n);
  const beta = new Float32Array(n);
  const zero = new Float32Array(n);

  const invSqrt3 = 1.0 / Math.sqrt(3.0);

  for (let i = 0; i < n; i++) {
    const a = ua[i];
    const b = ub[i];
    const c = uc[i];

    alpha[i] = (2.0 / 3.0) * a - (1.0 / 3.0) * b - (1.0 / 3.0) * c;
    beta[i] = invSqrt3 * (b - c);
    zero[i] = (1.0 / 3.0) * (a + b + c);
  }

  return { alpha, beta, zero };
}

/**
 * Computes Park Transform:
 *   d =  alpha * cos(theta) + beta * sin(theta)
 *   q = -alpha * sin(theta) + beta * cos(theta)
 *
 * @param alpha Float32Array
 * @param beta Float32Array
 * @param theta Float32Array of electrical rotor angle (in radians)
 */
export function computePark(
  alpha: Float32Array,
  beta: Float32Array,
  theta: Float32Array
): ParkResult {
  const n = alpha.length;
  if (beta.length !== n || theta.length !== n) {
    throw new Error('Alpha, Beta, and Theta arrays must have identical lengths.');
  }

  const d = new Float32Array(n);
  const q = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    const a = alpha[i];
    const b = beta[i];
    const th = theta[i];

    const cosTh = Math.cos(th);
    const sinTh = Math.sin(th);

    d[i] = a * cosTh + b * sinTh;
    q[i] = -a * sinTh + b * cosTh;
  }

  return { d, q };
}

/**
 * Computes Instantaneous Three-Phase Power:
 *   P(t) = Ua(t)*Ia(t) + Ub(t)*Ib(t) + Uc(t)*Ic(t)
 */
export function computeInstantaneousPower(
  ua: Float32Array,
  ub: Float32Array,
  uc: Float32Array,
  ia: Float32Array,
  ib: Float32Array,
  ic: Float32Array
): Float32Array {
  const n = ua.length;
  if (
    ub.length !== n ||
    uc.length !== n ||
    ia.length !== n ||
    ib.length !== n ||
    ic.length !== n
  ) {
    throw new Error('All 6 voltage and current arrays must have identical lengths.');
  }

  const power = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    power[i] = ua[i] * ia[i] + ub[i] * ib[i] + uc[i] * ic[i];
  }
  return power;
}
