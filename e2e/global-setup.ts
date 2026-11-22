// 測試開始前產生假麥克風用的 WAV（封包需以當下時間簽章）
import { mkdirSync, writeFileSync } from 'node:fs';
import { makeE2eWav } from '../scripts/make-e2e-wav.ts';

export default async function globalSetup(): Promise<void> {
  mkdirSync('e2e/fixtures', { recursive: true });
  writeFileSync('e2e/fixtures/broadcast.wav', await makeE2eWav());
}
