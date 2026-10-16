import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const DEFAULT_DATA_DIR = path.resolve(process.cwd(), 'data');
const FALLBACK_DATA_DIR = path.join(os.tmpdir(), 'finra-data-chart-next-02', 'data');

const DATA_DIR = existsSync(DEFAULT_DATA_DIR) ? DEFAULT_DATA_DIR : FALLBACK_DATA_DIR;
export const RECENT_SEEDS_FILE = path.join(DATA_DIR, 'national', 'finra-recent-seeds.json');

