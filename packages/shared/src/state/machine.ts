import { err, ok, type Result } from '../types/common.js';

/**
 * A pure transition table over a finite string union.
 *
 * Both lifecycles in Facture are small enough to write out completely, and writing them out
 * completely is the point: an illegal transition should be a value the caller can inspect
 * and explain, not an exception thrown from three layers down. Nothing here touches a
 * clock, a database or a chain — guards that need those belong at the call site, and the
 * table stays a function of `(from, to)` alone.
 */

export type TransitionTable<S extends string> = Readonly<Record<S, readonly S[]>>;

export interface IllegalTransition<S extends string> {
  readonly code: 'ILLEGAL_TRANSITION';
  readonly from: S;
  readonly to: S;
  /** Everything that *would* have been legal from `from`. */
  readonly allowed: readonly S[];
  readonly reason: string;
}

export interface TerminalState<S extends string> {
  readonly code: 'TERMINAL_STATE';
  readonly from: S;
  readonly to: S;
  readonly reason: string;
}

export interface UnknownState {
  readonly code: 'UNKNOWN_STATE';
  readonly value: string;
  readonly reason: string;
}

export type TransitionError<S extends string> =
  IllegalTransition<S> | TerminalState<S> | UnknownState;

export interface StateMachine<S extends string> {
  readonly name: string;
  readonly states: readonly S[];
  readonly table: TransitionTable<S>;
  /** States with no outgoing transitions. */
  readonly terminalStates: readonly S[];
  isState(value: unknown): value is S;
  isTerminal(state: S): boolean;
  allowedTransitions(state: S): readonly S[];
  canTransition(from: S, to: S): boolean;
  /**
   * Returns the new state on success. A self-transition (`from === to`) is *not* legal
   * unless the table lists it — a no-op write is almost always a bug in the caller rather
   * than an intent to stay put.
   */
  transition(from: S, to: S): Result<S, TransitionError<S>>;
  /** Same, but for values that have not been validated as states yet (DB rows, request bodies). */
  transitionUnchecked(from: string, to: string): Result<S, TransitionError<S>>;
}

export function createStateMachine<S extends string>(
  name: string,
  states: readonly S[],
  table: TransitionTable<S>,
): StateMachine<S> {
  const stateSet = new Set<string>(states);
  const terminalStates = states.filter((s) => table[s].length === 0);

  const isState = (value: unknown): value is S => typeof value === 'string' && stateSet.has(value);

  const allowedTransitions = (state: S): readonly S[] => table[state];

  const canTransition = (from: S, to: S): boolean => table[from].includes(to);

  const transition = (from: S, to: S): Result<S, TransitionError<S>> => {
    const allowed = table[from];
    if (allowed.includes(to)) return ok(to);
    if (allowed.length === 0) {
      return err({
        code: 'TERMINAL_STATE',
        from,
        to,
        reason: `${name} is ${from}, which is final; it cannot become ${to}.`,
      });
    }
    return err({
      code: 'ILLEGAL_TRANSITION',
      from,
      to,
      allowed,
      reason: `${name} cannot go from ${from} to ${to}. Legal next states: ${allowed.join(', ')}.`,
    });
  };

  const transitionUnchecked = (from: string, to: string): Result<S, TransitionError<S>> => {
    if (!isState(from)) {
      return err({
        code: 'UNKNOWN_STATE',
        value: from,
        reason: `${from} is not a ${name} state.`,
      });
    }
    if (!isState(to)) {
      return err({
        code: 'UNKNOWN_STATE',
        value: to,
        reason: `${to} is not a ${name} state.`,
      });
    }
    return transition(from, to);
  };

  return {
    name,
    states,
    table,
    terminalStates,
    isState,
    isTerminal: (state: S) => table[state].length === 0,
    allowedTransitions,
    canTransition,
    transition,
    transitionUnchecked,
  };
}

/**
 * Every state reachable from `start` in the given table. Used by the tests to assert that no
 * state is stranded and that every terminal state is actually reachable.
 */
export function reachableFrom<S extends string>(table: TransitionTable<S>, start: S): Set<S> {
  const seen = new Set<S>([start]);
  const queue: S[] = [start];
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined) break;
    for (const next of table[current]) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}
