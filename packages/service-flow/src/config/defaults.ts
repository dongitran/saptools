export const DEFAULT_IGNORES = [
  'node_modules',
  'gen',
  'dist',
  'coverage',
  '.git',
  '.turbo',
  '.next',
  '.cache',
  '.service-flow'
] as const;
export const CONFIG_DIR = '.service-flow';
export const CONFIG_FILE = 'config.json';
export const DEFAULT_DB_FILE = 'service-flow.db';
