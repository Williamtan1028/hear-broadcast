import { readFileSync } from 'node:fs';
import { parseWith, stationsFileSchema, templatePackSchema } from '../src/data/schema.ts';

/** 讀取 public/data 的預設資料（測試用） */
export const loadPack = () =>
  parseWith(
    templatePackSchema,
    JSON.parse(readFileSync('public/data/template-pack.json', 'utf8')),
    'template-pack.json',
  );
export const loadStations = () =>
  parseWith(
    stationsFileSchema,
    JSON.parse(readFileSync('public/data/stations.json', 'utf8')),
    'stations.json',
  );
