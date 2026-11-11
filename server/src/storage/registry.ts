import { s3Definition } from './s3';
import { webdavDefinition } from './webdav';
import type { DriverDefinition } from './types';

/**
 * Driver registry. Workers entry gets the portable drivers; the Node entry
 * additionally registers `local`. Phase 2 drivers (onedrive, gdrive,
 * telegram, discord, huggingface, github) plug in here via registerDriver().
 */
const drivers = new Map<string, DriverDefinition>();

export function registerDriver(def: DriverDefinition): void {
  drivers.set(def.type, def);
}

export function getDriverDefinition(type: string): DriverDefinition | undefined {
  return drivers.get(type);
}

export function listDriverDefinitions(): DriverDefinition[] {
  return [...drivers.values()];
}

registerDriver(s3Definition);
registerDriver(webdavDefinition);
