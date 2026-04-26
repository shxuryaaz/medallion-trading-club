import fs from 'fs/promises';
import path from 'path';

export const EVOLUTION_DATA_DIR = process.env.DATA_DIR?.trim() || path.join(process.cwd(), 'data');

export async function readEvolutionJson<T>(fileName: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(path.join(EVOLUTION_DATA_DIR, fileName), 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export async function writeEvolutionJson<T>(fileName: string, value: T): Promise<void> {
  await fs.mkdir(EVOLUTION_DATA_DIR, { recursive: true });
  const target = path.join(EVOLUTION_DATA_DIR, fileName);
  const tmp = path.join(EVOLUTION_DATA_DIR, `.${fileName}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(tmp, target);
}
