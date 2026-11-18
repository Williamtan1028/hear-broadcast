/**
 * 基準評估：產生 docs/benchmarks.md 用的 Markdown 表格。
 *   npm run bench -- [opts|doppler|combining|ggwave|perf|speed|all]
 * 每個區段的結果另存到 bench/out/<區段>.md。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { biquadHighpass } from '../src/modem/dsp.ts';
import { AutoReceiver } from '../src/modem/autoReceiver.ts';
import {
  BASELINE_OPTIONS,
  CANDIDATES,
  DEFAULT_OPTIONS,
  DEFAULTS,
  MODES,
  type ModemConfig,
  type RxOptions,
} from '../src/modem/config.ts';
import { packetDuration, synthesize } from '../src/modem/fsk.ts';
import { lowBandEnergyDb } from '../src/modem/leakage.ts';
import {
  SCENARIOS,
  SCENARIO_LABELS,
  channel,
  makeRng,
  walkingVelocity,
  type ChannelOptions,
} from './channel.ts';
import { GG_PROTOCOLS, ggDecode, ggEncode, loadGgwave, randomText } from './ggwave.ts';
import { runTrials, type TrialSpec } from './trial.ts';

const N = Number(process.env.BENCH_N ?? 30);
const out: string[] = [];
const log = (s = '') => {
  out.push(s);
  console.log(s);
};
const pct = (ok: number, n: number) => `${Math.round((100 * ok) / n)}%（${ok}/${n}）`;

function measure(mk: (i: number) => TrialSpec, n = N): { ok: number; wrong: number; ms: number } {
  const t0 = performance.now();
  const r = runTrials(n, mk);
  return { ok: r.ok, wrong: r.wrong, ms: (performance.now() - t0) / n };
}

const TONES: [number, number][] = [
  [19853, 0.01],
  [20096, 0.01],
];
const SCEN: [string, ChannelOptions][] = [
  ...(Object.keys(SCENARIOS) as (keyof typeof SCENARIOS)[]).map(
    (k) => [SCENARIO_LABELS[k], SCENARIOS[k]] as [string, ChannelOptions],
  ),
  ['中等＋窄頻干擾（19853、20096 Hz）', { ...SCENARIOS.medium, tones: TONES }],
];

/** 各項優化分別開啟 vs baseline */
function sectionOpts(): void {
  const sets: [string, Partial<RxOptions>][] = [
    ['baseline（PoC）', BASELINE_OPTIONS],
    ['＋低 SNR 偵測', { ...BASELINE_OPTIONS, snrDetect: true }],
    ['＋都卜勒（含追蹤）', { ...BASELINE_OPTIONS, doppler: true, tracking: true }],
    ['＋軟判決／抹除', { ...BASELINE_OPTIONS, erasure: true }],
    ['＋頻道白化', { ...BASELINE_OPTIONS, whitening: true }],
    ['預設（全部開啟）', DEFAULT_OPTIONS],
  ];
  for (const ts of [MODES.standard, MODES.stable]) {
    log(
      `\n#### ${ts === MODES.standard ? '標準' : '穩定'}模式（${ts * 1000} ms），48 kHz → 44.1 kHz，每格 ${N} 次\n`,
    );
    log(`| 情境 | ${sets.map((s) => s[0]).join(' | ')} |`);
    log(`|---|${sets.map(() => '---').join('|')}|`);
    const time = sets.map(() => 0);
    for (const [label, ch] of SCEN) {
      const cells = sets.map(([, o], k) => {
        const r = measure((i) => ({ cfg: { ...DEFAULTS, ts }, ch, opts: o, rng: makeRng(60_000 + i) }));
        time[k] += r.ms;
        return pct(r.ok, N) + (r.wrong ? ` ⚠${r.wrong} 錯` : '');
      });
      log(`| ${label} | ${cells.join(' | ')} |`);
    }
    log(`| 平均每次試驗計算時間 | ${time.map((t) => `${(t / SCEN.length).toFixed(0)} ms`).join(' | ')} |`);
  }
}

/** 都卜勒容忍度 */
function sectionDoppler(): void {
  const sets: [string, Partial<RxOptions>][] = [
    ['baseline', BASELINE_OPTIONS],
    ['都卜勒（無追蹤）', { ...DEFAULT_OPTIONS, tracking: false }],
    ['都卜勒＋追蹤（預設）', DEFAULT_OPTIONS],
  ];
  const vs = [0, 0.3, 0.5, -0.5, 1, -1, 1.5, -1.5, 'walk'] as const;
  for (const [scen, ch] of [
    ['安靜', SCENARIOS.quiet],
    ['中等', SCENARIOS.medium],
  ] as const) {
    log(`\n#### ${scen}情境，標準模式，每格 ${N} 次\n`);
    log(`| 速度 | ${sets.map((s) => s[0]).join(' | ')} | 自動偵測（預設） |`);
    log(`|---|${sets.map(() => '---').join('|')}|---|`);
    for (const v of vs) {
      const mk = (o: Partial<RxOptions>, mode: 'manual' | 'auto') => (i: number) => {
        const rng = makeRng(70_000 + i);
        const cfg: ModemConfig = mode === 'auto' ? CANDIDATES[i % CANDIDATES.length] : DEFAULTS;
        return { cfg, ch: { ...ch, velocity: v === 'walk' ? walkingVelocity(rng) : v }, opts: o, rng, mode };
      };
      const cells = sets.map(([, o]) => pct(measure(mk(o, 'manual')).ok, N));
      cells.push(pct(measure(mk(DEFAULT_OPTIONS, 'auto')).ok, N));
      log(`| ${v === 'walk' ? '走路 0.5～1.5 m/s 變化' : `${v} m/s`} | ${cells.join(' | ')} |`);
    }
  }
}

/** 重送合併 */
function sectionCombining(): void {
  log(`\n#### 重送合併（標準模式，每格 ${N + 10} 次；兩次傳送間使用獨立的通道實現）\n`);
  log('| 情境 | 單次接收 | 送兩次、不合併 | 送兩次＋合併 | 提升（相對單次） |');
  log('|---|---|---|---|---|');
  const n = N + 10;
  const noComb = { ...DEFAULT_OPTIONS, combining: false };
  for (const k of ['strong', 'extreme', 'hfMedium', 'hfStrong'] as const) {
    const ch = SCENARIOS[k];
    const a = measure((i) => ({ cfg: DEFAULTS, ch, opts: noComb, rng: makeRng(80_000 + i) }), n);
    const b = measure((i) => ({ cfg: DEFAULTS, ch, opts: noComb, rng: makeRng(80_000 + i), repeats: 2 }), n);
    const c = measure(
      (i) => ({ cfg: DEFAULTS, ch, opts: DEFAULT_OPTIONS, rng: makeRng(80_000 + i), repeats: 2 }),
      n,
    );
    log(
      `| ${SCENARIO_LABELS[k]} | ${pct(a.ok, n)} | ${pct(b.ok, n)} | ${pct(c.ok, n)} | ${Math.round((100 * (c.ok - a.ok)) / n)} 個百分點 |`,
    );
  }
}

/** ggwave 對照 */
async function sectionGgwave(): Promise<void> {
  const g = await loadGgwave();
  const quietLog = console.log;
  const hp = (x: Float32Array, fs: number) => {
    const a = biquadHighpass(fs, 12000);
    const b = biquadHighpass(fs, 12000);
    return x.map((v) => b(a(v)));
  };
  const n = N;
  log(`\n#### 速度與洩漏（payload 8 bytes）\n`);
  log('| 方法 | 頻段 | 封包時間 | 每秒 bytes | 16 kHz 以下能量 | 18 kHz 以下能量 |');
  log('|---|---|---|---|---|---|');
  console.log = () => {};
  const ggSig = Object.fromEntries(GG_PROTOCOLS.map((p) => [p, ggEncode(g, 'abcdefgh', p, 0.6)]));
  console.log = quietLog;
  for (const p of GG_PROTOCOLS) {
    const s = ggSig[p];
    const [a, b] = lowBandEnergyDb(s, 48000, [16000, 18000]);
    log(
      `| ggwave ${p} | 15.0～19.5 kHz | ${(s.length / 48000).toFixed(2)} s | ${(8 / (s.length / 48000)).toFixed(1)} | ${a.toFixed(1)} dB | ${b.toFixed(1)} dB |`,
    );
  }
  for (const [name, ts] of [
    ['標準', MODES.standard],
    ['穩定', MODES.stable],
  ] as const) {
    const cfg = { ...DEFAULTS, ts };
    const s = synthesize([1, 2, 3, 4, 5, 6, 7, 8], cfg, 48000, 0.6);
    const [a, b] = lowBandEnergyDb(s, 48000, [16000, 18000]);
    const d = packetDuration(8, cfg);
    log(
      `| 聽見廣播（${name}） | 19.5～20.35 kHz | ${d.toFixed(2)} s | ${(8 / d).toFixed(1)} | ${a.toFixed(1)} dB | ${b.toFixed(1)} dB |`,
    );
  }

  log(`\n#### 成功率（相同峰值振幅 0.6、相同通道；每格 ${n} 次）\n`);
  log(
    '| 情境 | 接收取樣率 | ggwave [U] Fast | ggwave [U] Fast＋高通 | ggwave [U] Normal＋高通 | 聽見廣播（標準、預設） |',
  );
  log('|---|---|---|---|---|---|');
  for (const k of ['quiet', 'medium', 'strong', 'hfQuiet'] as const) {
    for (const fsRx of [48000, 44100]) {
      const ch = SCENARIOS[k];
      let raw = 0;
      let hpf = 0;
      let hpn = 0;
      console.log = () => {};
      for (let i = 0; i < n; i++) {
        const rng = makeRng(90_000 + i);
        const t = randomText(rng, 8);
        const y = channel(ggEncode(g, t, 'ULTRASOUND_FAST', 0.6), 48000, fsRx, ch, rng);
        if (ggDecode(g, y, fsRx) === t) raw++;
        if (ggDecode(g, hp(y, fsRx), fsRx) === t) hpf++;
        const rng2 = makeRng(90_000 + i);
        const t2 = randomText(rng2, 8);
        const y2 = channel(ggEncode(g, t2, 'ULTRASOUND_NORMAL', 0.6), 48000, fsRx, ch, rng2);
        if (ggDecode(g, hp(y2, fsRx), fsRx) === t2) hpn++;
      }
      console.log = quietLog;
      const ours = measure(
        (i) => ({ cfg: DEFAULTS, ch, opts: DEFAULT_OPTIONS, rng: makeRng(90_000 + i), fsRx }),
        n,
      );
      log(
        `| ${SCENARIO_LABELS[k]} | ${fsRx / 1000} kHz | ${pct(raw, n)} | ${pct(hpf, n)} | ${pct(hpn, n)} | ${pct(ours.ok, n)} |`,
      );
    }
  }

  log(`\n#### 都卜勒容忍度（安靜情境、接收 48 kHz；每格 ${n} 次）\n`);
  log('| 速度 | ggwave [U] Fast＋高通 | 聽見廣播（預設） |');
  log('|---|---|---|');
  for (const v of [0, 0.5, 1, 1.5]) {
    let ok = 0;
    console.log = () => {};
    for (let i = 0; i < n; i++) {
      const rng = makeRng(95_000 + i);
      const t = randomText(rng, 8);
      const y = channel(
        ggEncode(g, t, 'ULTRASOUND_FAST', 0.6),
        48000,
        48000,
        { ...SCENARIOS.quiet, velocity: v },
        rng,
      );
      if (ggDecode(g, hp(y, 48000), 48000) === t) ok++;
    }
    console.log = quietLog;
    const ours = measure(
      (i) => ({
        cfg: DEFAULTS,
        ch: { ...SCENARIOS.quiet, velocity: v },
        opts: DEFAULT_OPTIONS,
        rng: makeRng(95_000 + i),
        fsRx: 48000,
      }),
      n,
    );
    log(`| ${v} m/s | ${pct(ok, n)} | ${pct(ours.ok, n)} |`);
  }
}

/** 效能 */
function sectionPerf(): void {
  log('\n#### AutoReceiver 處理 10 秒音訊的時間（Node，8 組候選設定）\n');
  log('| 設定 | 44.1 kHz | 48 kHz | FFT 次數（44.1 kHz） |');
  log('|---|---|---|---|');
  for (const [name, o] of [
    ['baseline（Goertzel，每組 6 頻道）', BASELINE_OPTIONS],
    ['預設（共用 FFT＋±120 Hz 頻偏搜尋）', DEFAULT_OPTIONS],
  ] as const) {
    const cells: string[] = [];
    let ffts = 0;
    for (const fs of [44100, 48000]) {
      const rng = makeRng(3);
      const x = Float32Array.from({ length: fs * 10 }, () => (rng() * 2 - 1) * 0.05);
      const a = new AutoReceiver(fs, { opts: o });
      a.push(new Float32Array(4096));
      const t0 = performance.now();
      for (let i = 0; i < x.length; i += 4096) a.push(x.subarray(i, i + 4096));
      cells.push(`${(performance.now() - t0).toFixed(0)} ms`);
      if (fs === 44100) ffts = a.spectra.computed;
    }
    log(`| ${name} | ${cells.join(' | ')} | ${ffts} |`);
  }
}

const sections: Record<string, () => void | Promise<void>> = {
  opts: sectionOpts,
  doppler: sectionDoppler,
  combining: sectionCombining,
  ggwave: sectionGgwave,
  perf: sectionPerf,
};

const which = process.argv[2] ?? 'all';
mkdirSync('bench/out', { recursive: true });
for (const [name, fn] of Object.entries(sections)) {
  if (which !== 'all' && which !== name) continue;
  out.length = 0;
  log(`\n### ${name}`);
  await fn();
  writeFileSync(`bench/out/${name}.md`, out.join('\n') + '\n');
}
