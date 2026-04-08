import type { AgencyScraper, KnownAgencyId } from "./types";
import { busnearbyScraper } from "./busnearby/busnearby-scraper";
import { eggedScraper } from "./egged/egged-scraper";
import { danScraper } from "./dan/dan-scraper";
import { metropolineScraper } from "./metropoline/metropoline-scraper";
import { kavimScraper } from "./kavim/kavim-scraper";

const registry = {
  busnearby: busnearbyScraper,
  egged: eggedScraper,
  dan: danScraper,
  metropoline: metropolineScraper,
  kavim: kavimScraper,
} as const satisfies Record<KnownAgencyId, AgencyScraper>;

export function getScraper(id: string): AgencyScraper | undefined {
  return registry[id as KnownAgencyId];
}

export function listScrapers(): AgencyScraper[] {
  return Object.values(registry);
}

export function isKnownAgencyId(id: string): id is KnownAgencyId {
  return id in registry;
}
