/**
 * Capability lifecycle (RFA-0.9 sect. 8), and the honesty note that has to
 * travel with it.
 *
 * An offer that is removed disappears from the roster on the next digest
 * rotation, and every consumer discovers it by failing. `deprecated` and
 * `superseded_by` are the softer exit - and they are PACK-LOCAL by decision
 * (sect. 8.3): the agent card the hub serves is unchanged, so no roster, no
 * remote member and no interop client sees a new field, and wire Appendix F
 * gains no row.
 *
 * THE COST OF THAT DECISION, stated here because sect. 8.1 requires it to be
 * stated wherever the feature is documented: **a selector that reads
 * `card_summary.skill_ids` from the roster cannot see the flag at all.** So the
 * guarantee below binds selectors that read pack definitions on this host, and
 * an operator must not read it as a room-wide one. `rfa ask --capability` and
 * the dashboard's picker are roster readers and are deliberately NOT bound.
 */

export interface OfferLike {
  id: string;
  description: string;
  deprecated?: boolean;
  superseded_by?: string;
}

export interface OfferSelection<T extends OfferLike> {
  /** What the selector may use. */
  chosen: T[];
  /** One note per deprecated offer that was chosen anyway, because nothing else matched. */
  notes: string[];
}

/** How a deprecated offer is named wherever one is shown or chosen. One sentence, one source. */
export function deprecationNote(offer: OfferLike): string {
  return (
    `\`${offer.id}\` is deprecated` +
    (offer.superseded_by ? `, superseded by \`${offer.superseded_by}\`` : " with no named successor") +
    ` (RFA-0.9 sect. 8.1; pack-local - the room's roster does not carry this flag)`
  );
}

/**
 * Sect. 8.1's rule, and ONLY that rule: a local selector MUST NOT choose a
 * deprecated offer when a non-deprecated one matches, and MUST name the
 * deprecation when it chooses one anyway.
 *
 * `matches` is the caller's own predicate, so this owns the deprecation rule and
 * nothing else; a selector that also filtered here would be two rules in one
 * place and the second would drift. It returns a LIST because both shapes of
 * local selector exist - "pick the one to ask" and "list what this room offers"
 * - and both are bound by the same sentence.
 */
export function selectOffers<T extends OfferLike>(offers: readonly T[], matches: (o: T) => boolean = () => true): OfferSelection<T> {
  const eligible = offers.filter(matches);
  const live = eligible.filter((o) => !o.deprecated);
  if (live.length > 0) return { chosen: live, notes: [] };
  return { chosen: eligible, notes: eligible.filter((o) => o.deprecated).map(deprecationNote) };
}

/** Every deprecated offer across a set of packs, with its successor, for `rfa doctor` (sect. 8.1). */
export function deprecatedOffers(packs: readonly { name: string; def: { offers?: OfferLike[] } }[]): { pack: string; offer: OfferLike; note: string }[] {
  const out: { pack: string; offer: OfferLike; note: string }[] = [];
  for (const p of packs) for (const o of p.def.offers ?? []) if (o.deprecated) out.push({ pack: p.name, offer: o, note: deprecationNote(o) });
  return out;
}
