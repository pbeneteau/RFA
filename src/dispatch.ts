/**
 * The dispatcher (RFA-0.8 sect. 6.2). The design note is
 * `docs/design/rung3-dispatcher.md`; this file is the policy half of it.
 *
 * What it replaces. `RoomMember.serve()` was serial twice over, and the second
 * one was the expensive one: while a turn ran, `listenOnce` was not called, so
 * incoming requests were not queued behind the turn, they were UNREAD. A peer
 * asking a busy resident got dead air until its `reply_by`, and the resident
 * could not even say it was busy. The loop now keeps reading and hands every
 * request here.
 *
 * Four requirements, all normative, and where each lives:
 *
 *  1. per-conversation FIFO queues        -> `queues`, one array per key
 *  2. one writer per session id           -> `running`, one job per key at a time
 *  3. backpressure, never a silent drop   -> `queueLimit` / `maxQueued`, refusing the ARRIVAL
 *  4. deadline-aware admission            -> `admitDeadline`, checked at submit AND at dequeue
 *
 * Requirements 1 and 2 are ONE mechanism seen twice, and that is the load-bearing
 * observation: a conversation key owns a session id (`src/sessions.ts`), so "at
 * most one running job per conversation key" IS "at most one writer per session
 * id". Key this on anything other than the session key and the session book
 * throws instead - correctly, and far too late to be useful.
 *
 * Deliberately transport-agnostic: jobs and callbacks, never an envelope and
 * never the hub. The caller owns the wire and sends every refusal this returns.
 * That is what lets the acceptance test be a unit test driven by barriers rather
 * than a live room.
 *
 * NOT here, and not by omission: in-process lane priority (PARKED, Appendix A;
 * the account layer already has per-lane reserves and the trigger is a measured
 * serve-latency incident), grant-order or starvation policy (PARKED), any form
 * of same-session concurrency (REJECTED: sessions fork, they do not share), and
 * the cross-process cap, which is the account ledger's and stays there.
 */

/** How long a turn must plausibly have, or admitting it is buying a dead answer. */
export const MIN_VIABLE_TURN_MS = 5_000;
/**
 * The seed for the turn-duration estimate, before any turn has been measured.
 * The dogfood pack's measured range is 10-17 s; 20 s is deliberately above it,
 * because over-estimating makes the dispatcher refuse work it probably could not
 * have finished, and under-estimating makes it accept work it certainly cannot.
 */
export const DEFAULT_TURN_MS = 20_000;

export interface DispatchJob {
  /**
   * The FIFO group, and the session fence. This MUST be the same key the session
   * book uses for this conversation (`conversationKey()` in `src/client.ts`).
   */
  key: string;
  /** Stable identity, for the skip predicate and for logs. */
  id: string;
  /** The asker's deadline as an ISO instant, or null when it sent none. */
  replyBy: string | null;
  /** The work. Its resolution or rejection frees the slot; rejection is reported, never thrown here. */
  run: () => Promise<void>;
  /**
   * Called when the job is shed AFTER admission (it sat in the queue past its
   * deadline). The caller puts the refusal on the wire. Never called for a
   * refusal at submit: `submit` returns that one synchronously.
   */
  onShed?: (reason: "deadline_expired", detail: string) => void;
}

export type Admission =
  | { verdict: "queued" }
  /** Put this on the wire as an ordinary refusal. */
  | { verdict: "refused"; reason: "overloaded" | "deadline_expired"; detail: string; retryAfterS?: number }
  /** Nothing to send: something else already answered this id. */
  | { verdict: "skipped"; detail: string };

export interface DispatcherOptions {
  /** Turns this process may run at once. 1 is the default and reproduces the pre-rung-3 shape. */
  concurrency?: number;
  /** Queued jobs allowed per conversation key. */
  queueLimit?: number;
  /** Queued jobs allowed across every key. Defaults to `concurrency * 8`. */
  maxQueued?: number;
  /** Retry hint on a backpressure refusal. */
  retryAfterS?: number;
  /**
   * A job already answered by something else (rung 2's inline `would_deadlock`
   * refusals). Consulted at submit AND at dequeue: the queue makes the window
   * wide enough that a job can be refused inline while it waits, and answering
   * it afterwards from a turn nobody is waiting on is the exact second-order bug
   * rung 2 recorded.
   */
  shouldSkip?: (job: DispatchJob) => string | null;
  onError?: (err: Error, job: DispatchJob) => void;
  /** Injectable for tests; production passes nothing. */
  now?: () => number;
}

export interface DispatchStats {
  concurrency: number;
  inFlight: number;
  queued: number;
  keys: number;
  /** The EWMA behind the deadline estimate, in ms. */
  meanTurnMs: number;
}

export class Dispatcher {
  private readonly queues = new Map<string, DispatchJob[]>();
  private readonly running = new Set<string>();
  private inFlight = 0;
  private queued = 0;
  private meanTurnMs = DEFAULT_TURN_MS;
  private idleWaiters: (() => void)[] = [];
  private readonly now: () => number;
  readonly concurrency: number;
  private readonly queueLimit: number;
  private readonly maxQueued: number;
  private readonly retryAfterS: number;

  constructor(private readonly opts: DispatcherOptions = {}) {
    this.concurrency = Math.max(1, Math.floor(opts.concurrency ?? 1));
    this.queueLimit = Math.max(1, Math.floor(opts.queueLimit ?? 4));
    this.maxQueued = Math.max(this.queueLimit, Math.floor(opts.maxQueued ?? this.concurrency * 8));
    this.retryAfterS = opts.retryAfterS ?? 30;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Admit, refuse or skip - synchronously, because the caller has to answer on
   * the wire in the same tick and a promise here would be a queue in front of
   * the queue.
   */
  submit(job: DispatchJob): Admission {
    const skip = this.opts.shouldSkip?.(job);
    if (skip) return { verdict: "skipped", detail: skip };

    // Requirement 4, first half. The estimate is only ever used to refuse work
    // that could not have finished anyway: with nothing queued ahead on this key
    // it degenerates to the plain "has the deadline already passed" test.
    const ahead = this.queues.get(job.key)?.length ?? 0;
    const startsAt = this.now() + ahead * this.meanTurnMs;
    const dead = this.deadlineVerdict(job, startsAt);
    if (dead) {
      return {
        verdict: "refused",
        reason: "deadline_expired",
        detail: dead,
      };
    }

    // Requirement 3. The ARRIVAL is refused, never a queued job dropped: a
    // dropped queued job is silence for somebody who is already waiting, which
    // is the failure the requirement names.
    if (this.queued >= this.maxQueued) {
      return {
        verdict: "refused",
        reason: "overloaded",
        detail: `this agent has ${this.queued} requests queued across ${this.queues.size} conversation(s) and ${this.inFlight} in flight (concurrency ${this.concurrency})`,
        retryAfterS: this.retryAfterS,
      };
    }
    if (ahead >= this.queueLimit) {
      return {
        verdict: "refused",
        reason: "overloaded",
        detail: `this conversation already has ${ahead} request(s) queued (limit ${this.queueLimit})`,
        retryAfterS: this.retryAfterS,
      };
    }

    const q = this.queues.get(job.key);
    if (q) q.push(job);
    else this.queues.set(job.key, [job]);
    this.queued++;
    this.pump();
    return { verdict: "queued" };
  }

  /** The number the consolidation timer and the presence meter read. */
  inFlightCount(): number {
    return this.inFlight;
  }

  queuedCount(): number {
    return this.queued;
  }

  stats(): DispatchStats {
    return {
      concurrency: this.concurrency,
      inFlight: this.inFlight,
      queued: this.queued,
      keys: this.queues.size,
      meanTurnMs: Math.round(this.meanTurnMs),
    };
  }

  /** Resolves when nothing is queued and nothing is running: the drain, for shutdown and for tests. */
  async idle(): Promise<void> {
    if (this.inFlight === 0 && this.queued === 0) return;
    await new Promise<void>((r) => this.idleWaiters.push(r));
  }

  /**
   * `null` when the job may start at `startsAt`, else why not. `MIN_VIABLE_TURN_MS`
   * rather than `> 0` for the same reason the budget floor is not `> 0`: a
   * deadline two seconds out buys a truncated answer nobody can use, and refusing
   * it is both cheaper and more honest than delivering one.
   */
  private deadlineVerdict(job: DispatchJob, startsAt: number): string | null {
    if (!job.replyBy) return null;
    const by = Date.parse(job.replyBy);
    if (!Number.isFinite(by)) return null;
    if (by > startsAt + MIN_VIABLE_TURN_MS) return null;
    const late = Math.round((startsAt + MIN_VIABLE_TURN_MS - by) / 1000);
    return startsAt <= this.now()
      ? `its reply_by (${job.replyBy}) leaves under ${Math.round(MIN_VIABLE_TURN_MS / 1000)}s, which is not enough for one turn`
      : `it would start about ${Math.round((startsAt - this.now()) / 1000)}s from now, roughly ${late}s past its reply_by (${job.replyBy})`;
  }

  private pump(): void {
    while (this.inFlight < this.concurrency) {
      const next = this.take();
      if (!next) break;
      this.start(next);
    }
    if (this.inFlight === 0 && this.queued === 0 && this.idleWaiters.length > 0) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const w of waiters) w();
    }
  }

  /**
   * The next runnable job, skipping keys that are already running (that skip IS
   * the one-writer-per-session fence) and shedding at the door anything whose
   * deadline passed while it waited. Map insertion order gives FIFO within a key
   * and round-robin across keys: a running key is passed over, so a chatty
   * conversation cannot starve a quiet one.
   */
  private take(): DispatchJob | null {
    for (const [key, q] of this.queues) {
      if (this.running.has(key) || q.length === 0) continue;
      while (q.length > 0) {
        const job = q.shift()!;
        this.queued--;
        if (q.length === 0) this.queues.delete(key);
        const skip = this.opts.shouldSkip?.(job);
        if (skip) continue;
        // Requirement 4, second half, and the half that makes a bounded queue
        // honest: starting a turn into a dead reply_by is a bill with no reader.
        const dead = this.deadlineVerdict(job, this.now());
        if (dead) {
          job.onShed?.("deadline_expired", dead);
          continue;
        }
        return job;
      }
    }
    return null;
  }

  private start(job: DispatchJob): void {
    this.running.add(job.key);
    this.inFlight++;
    const t0 = this.now();
    void job
      .run()
      .catch((err: Error) => this.opts.onError?.(err, job))
      .finally(() => {
        this.running.delete(job.key);
        this.inFlight--;
        // EWMA over real turns only. A shed or a refusal never reaches here, so
        // the estimate cannot be dragged down by work that was never done.
        const took = this.now() - t0;
        if (took > 0) this.meanTurnMs = this.meanTurnMs * 0.7 + took * 0.3;
        this.pump();
      });
  }
}
