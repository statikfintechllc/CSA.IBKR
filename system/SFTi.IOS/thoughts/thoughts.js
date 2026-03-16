/**
 * SFTi.IOS/thoughts/thoughts.js — Trading Journal / Notes
 *
 * A persistent, searchable trading journal stored client-side in the Vault.
 * Attach notes to specific tickers, trades, or time ranges.
 */

import { Vault } from '../storage/vault.js';

export class Thoughts {
  constructor() {
    this._vault = new Vault('sfti.ios.thoughts');
  }

  /**
   * Add a thought/note.
   * @param {object} thought
   * @param {string}  thought.text     Note content
   * @param {string}  [thought.ticker] Associated ticker
   * @param {string}  [thought.tag]    Optional tag (e.g. "setup", "review")
   * @returns {Promise<string>}         Generated thought ID
   */
  async add(thought) {
    const id = crypto.randomUUID();
    const entry = {
      id,
      text: thought.text,
      ticker: thought.ticker || null,
      tag: thought.tag || null,
      ts: Date.now(),
    };
    const all = await this._all();
    all.unshift(entry);
    await this._vault.set('thoughts', all);
    return id;
  }

  /**
   * Get all thoughts, optionally filtered.
   * @param {object} [filter]
   * @param {string} [filter.ticker]
   * @param {string} [filter.tag]
   * @returns {Promise<object[]>}
   */
  async get(filter = {}) {
    let all = await this._all();
    if (filter.ticker) all = all.filter((t) => t.ticker === filter.ticker);
    if (filter.tag) all = all.filter((t) => t.tag === filter.tag);
    return all;
  }

  /**
   * Delete a thought by ID.
   * @param {string} id
   */
  async delete(id) {
    const all = await this._all();
    const filtered = all.filter((t) => t.id !== id);
    await this._vault.set('thoughts', filtered);
  }

  /**
   * Search thought text (case-insensitive substring).
   * @param {string} query
   * @returns {Promise<object[]>}
   */
  async search(query) {
    const q = query.toLowerCase();
    const all = await this._all();
    return all.filter((t) => t.text.toLowerCase().includes(q));
  }

  async _all() {
    return (await this._vault.get('thoughts')) || [];
  }
}

export default Thoughts;
