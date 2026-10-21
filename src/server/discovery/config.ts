/**
 * Provider configuration local to the discovery layer.
 *
 * Replaces a 222-line shared config module of which exactly one export was
 * reachable from here — the rest was WhatsApp, Instagram, Meta and eight
 * hardcoded API Gateway URLs.
 *
 * Getters rather than captured constants: reading `process.env` at call time
 * means tests can flip a key without resetting the module registry.
 */

export const BRIGHTDATA_CONFIG = {
  get API_TOKEN() {
    return process.env.BRIGHTDATA_API_TOKEN || '';
  },
  get IS_CONFIGURED() {
    return Boolean(process.env.BRIGHTDATA_API_TOKEN);
  },
  API_URL: 'https://api.brightdata.com/datasets/v3',
  /** Dataset id from the BrightData dashboard. Defaults to LinkedIn People Profiles. */
  get SCRAPER_ID() {
    return process.env.BRIGHTDATA_SCRAPER_ID || 'gd_l1viktl72bvl7bjuj0';
  },
  get WEB_UNLOCKER_ZONE() {
    return process.env.BRIGHTDATA_WEB_UNLOCKER_ZONE || '';
  },
} as const;
