/**
 * CSA.IBKR — Config Loader (Engine Layer)
 * Replaces: SnakeYAML 1.17 + Vert.x JsonObject config
 * 
 * Loads, validates, and provides access to gateway configuration.
 * Supports multi-environment configs (production, alpha, beta).
 */

const CONFIG_PATH = '/system/configs/gateway/json/config.json';
const ENDPOINTS_PATH = '/system/configs/gateway/json/endpoints.json';

// Default config (fallback if config.json is unavailable)
const DEFAULT_CONFIG = Object.freeze({
  apiHost: 'https://api.ibkr.com',
  apiVersion: 'v1',
  region: 'US',
  authDelay: 3000,
  sessionKeepalive: 300000, // 5 minutes
  ssoLoginUrl: 'https://gdcdyn.interactivebrokers.com/sso/Login',
  ssoForwardTo: 22,
  corsAllowAll: true,
  wsEndpoint: '/v1/api/ws',
  tickleEndpoint: '/v1/api/tickle',
  authStatusEndpoint: '/v1/api/iserver/auth/status',
  logoutEndpoint: '/v1/api/logout',
  environment: 'production'
});

// Required config fields
const REQUIRED_FIELDS = ['apiHost', 'apiVersion', 'ssoLoginUrl'];

class ConfigLoader {
  #config = null;
  #endpoints = null;
  #loaded = false;

  constructor() {
    this.#config = { ...DEFAULT_CONFIG };
  }

  /**
   * Load configuration from JSON file.
   * Falls back to defaults if file is unavailable (offline-first).
   * @param {string} [environment] - Override environment (production|alpha|beta)
   * @returns {Promise<object>} Validated config object
   */
  async load(environment = null) {
    try {
      const [configResponse, endpointsResponse] = await Promise.allSettled([
        fetch(CONFIG_PATH),
        fetch(ENDPOINTS_PATH)
      ]);

      // Parse gateway config
      if (configResponse.status === 'fulfilled' && configResponse.value.ok) {
        const rawConfig = await configResponse.value.json();
        this.#config = this.#mergeConfig(DEFAULT_CONFIG, rawConfig);
      }

      // Parse endpoints catalog
      if (endpointsResponse.status === 'fulfilled' && endpointsResponse.value.ok) {
        this.#endpoints = await endpointsResponse.value.json();
      }

      // Apply environment overrides
      const env = environment || this.#config.environment || 'production';
      if (this.#config.environments && this.#config.environments[env]) {
        this.#config = this.#mergeConfig(this.#config, this.#config.environments[env]);
      }
      this.#config.environment = env;

      // Validate
      this.#validate();
      this.#loaded = true;

      return this.#config;
    } catch (err) {
      console.warn('[ConfigLoader] Failed to load config, using defaults:', err.message);
      this.#loaded = true;
      return this.#config;
    }
  }

  /**
   * Get the current config. Throws if not loaded.
   * @returns {object} Frozen config object
   */
  getConfig() {
    if (!this.#loaded) {
      throw new Error('[ConfigLoader] Config not loaded. Call load() first.');
    }
    return Object.freeze({ ...this.#config });
  }

  /**
   * Get a specific config value by key path (dot notation).
   * @param {string} key - e.g. 'apiHost' or 'environments.alpha.apiHost'
   * @param {*} [fallback] - Default if key not found
   * @returns {*} Config value
   */
  get(key, fallback = undefined) {
    if (!this.#loaded) {
      throw new Error('[ConfigLoader] Config not loaded. Call load() first.');
    }
    return key.split('.').reduce((obj, k) => (obj && obj[k] !== undefined ? obj[k] : fallback), this.#config);
  }

  /**
   * Get the full API base URL (apiHost + /apiVersion/api)
   * @returns {string} e.g. "https://api.ibkr.com/v1/api"
   */
  getApiBaseUrl() {
    const cfg = this.getConfig();
    const base = cfg.portalBase || '';
    return `${cfg.apiHost}${base}/${cfg.apiVersion}/api`;
  }

  /**
   * Get endpoints catalog.
   * @returns {object|null} Endpoint definitions
   */
  getEndpoints() {
    return this.#endpoints;
  }

  /**
   * Check if config has been loaded.
   * @returns {boolean}
   */
  isLoaded() {
    return this.#loaded;
  }

  // --- Private ---

  #mergeConfig(base, override) {
    const result = { ...base };
    for (const [key, value] of Object.entries(override)) {
      if (value !== null && typeof value === 'object' && !Array.isArray(value) && typeof base[key] === 'object') {
        result[key] = this.#mergeConfig(base[key], value);
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  #validate() {
    for (const field of REQUIRED_FIELDS) {
      if (!this.#config[field]) {
        throw new Error(`[ConfigLoader] Missing required config field: ${field}`);
      }
    }
    // Validate apiHost is a valid URL
    try {
      new URL(this.#config.apiHost);
    } catch {
      throw new Error(`[ConfigLoader] Invalid apiHost URL: ${this.#config.apiHost}`);
    }
  }
}

// Singleton instance
const configLoader = new ConfigLoader();

export { ConfigLoader, configLoader };
export default configLoader;
