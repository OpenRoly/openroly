// PBI-0592: bench の率に添える 95% の幅と、2 つの方式の差の検定。README / kpi が「この n では区別できない」を言う元。
// PBI-0604: 分位(p50 / p90)もここに集める —— **数式は scenario の script にも表の script にも書かない**。
// 時間・token・credit・Fidelity は全部この 1 つの口(distribution)を通す。

/** Wilson score interval(z = 1.96 = 95%)。n = 0 は null(幅を作らない) */
export function wilson(k: number, n: number, z = 1.96): { lo: number; hi: number } | null {
  if (n === 0) return null;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
}

/**
 * 分位(R の type 7 = 線形補間)。q = 0.5 は偶数件で真ん中 2 つの平均 —— 今までの median と同じ値。
 * 空なら null(分母が無い物を 0 と言わない)
 */
export function quantile(xs: readonly number[], q: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo]! + (s[hi]! - s[lo]!) * (i - lo);
}

/** p90 を出す最少の n。これ未満では裾を外挿しない(PBI-0604 AC-2) */
export const P90_MIN_N = 10;

export interface Dist {
  n: number;
  p50: number;
  /** n < P90_MIN_N なら null(`n<10` と書く。0 や p50 で埋めない) */
  p90: number | null;
}

/** 中央値 1 つでは裾が隠れる。値が 1 つも無ければ null */
export function distribution(xs: readonly number[]): Dist | null {
  const p50 = quantile(xs, 0.5);
  if (p50 === null) return null;
  return { n: xs.length, p50, p90: xs.length < P90_MIN_N ? null : quantile(xs, 0.9)! };
}

/**
 * Fisher の正確検定(両側)。2×2 = [a 成功, b 失敗] vs [c 成功, d 失敗]。
 * 周辺和を固定した超幾何分布で、観測した表以下の確率を持つ表の確率を足す(R の fisher.test と同じ定義)
 */
export function fisherExact(a: number, b: number, c: number, d: number): number {
  const logFact = (n: number) => {
    let s = 0;
    for (let i = 2; i <= n; i++) s += Math.log(i);
    return s;
  };
  const row1 = a + b;
  const col1 = a + c;
  const n = a + b + c + d;
  const logP = (x: number) =>
    logFact(row1) + logFact(n - row1) + logFact(col1) + logFact(n - col1) -
    (logFact(x) + logFact(row1 - x) + logFact(col1 - x) + logFact(n - row1 - col1 + x) + logFact(n));
  const observed = logP(a);
  let p = 0;
  for (let x = Math.max(0, col1 + row1 - n); x <= Math.min(row1, col1); x++) {
    const lp = logP(x);
    // 浮動小数の揺れで観測と同じ確率の表を落とさない(R も 1 + 1e-7 の相対許容)
    if (lp <= observed + 1e-7) p += Math.exp(lp);
  }
  return Math.min(1, p);
}
