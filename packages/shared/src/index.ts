/**
 * `@facture/shared` — the domain vocabulary every other package speaks.
 *
 * Nothing here touches the network, a database or a chain. It is types, pure maths and
 * constants, so it can be imported by the backend, the web app, the agent and the contract
 * tooling without any of them pulling in each other's runtime.
 */

export * from './types/index.js';
export * from './state/index.js';
export * from './pricing/index.js';
export * from './isin/index.js';
export * from './registry/index.js';
export * from './chains/index.js';
