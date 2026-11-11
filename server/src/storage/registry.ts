import { discordDefinition } from './discord';
import { gdriveDefinition } from './gdrive';
import { githubDefinition } from './github';
import { huggingfaceDefinition } from './huggingface';
import { onedriveDefinition } from './onedrive';
import { s3Definition } from './s3';
import { telegramDefinition } from './telegram';
import { webdavDefinition } from './webdav';
import type { DriverDefinition } from './types';

/**
 * Driver registry. Workers entry gets the portable drivers; the Node entry
 * additionally registers `local`.
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
registerDriver(onedriveDefinition);
registerDriver(gdriveDefinition);
registerDriver(telegramDefinition);
registerDriver(discordDefinition);
registerDriver(huggingfaceDefinition);
registerDriver(githubDefinition);
