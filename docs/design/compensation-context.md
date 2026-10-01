# Compensation amount ownership and period context

Stage77 · draft02. Status: consolidated proposal for explicit same-hash review; no design approval yet. This draft resolves the initial choices as specified below; each participant must either approve these exact bytes or identify a concrete blocker.

## Problem and intended result

The product compares explicitly known annual base salary, supports salary filters and shows city medians. The committed parser can mistake a signing bonus for base salary when an earlier salary phrase lends it context. It can also infer a salary unit from a review cadence, or lose a genuine annual unit because reviews occur monthly.

The change must associate each money amount with its own compensation component and amount unit. It must preserve genuine disclosed salary, original evidence and saved user context. It does not estimate missing compensation, annualize nonannual amounts, change FX rates or infer currency from a location.

Some reproduced sentences are synthetic diagnostic inputs. A search of the protected 6,819-job snapshot found 214 descriptions mentioning signing bonuses and 97 with review/adjustment phrases, but no comparable text-derived salary from those matching descriptions. These frequencies are not defect counts. The stage76 baseline has 1,224 comparable jobs and 2,436 jobs with structured board evidence.

Actual retained Greenhouse disclosures also show relevant defects. Eight Flexport ranges explicitly exclude bonus/equity/benefits but have a `total` basis; their numeric amounts, unknown periods and geographic restrictions must remain intact when correcting the basis. Databricks disclosures use the cadence of a separate annual performance bonus as an amount period, or let it conflict with an explicit hourly title. All these cited ranges already have `salary:null`; they are not a claim of new comparable jobs. Waymo's similar separate bonus-program prose currently leaves the period unknown and is a preservation control. Every semantic change in the historical corpus must be inspected before completion.

## Existing boundaries to retain

- Complete monetary tokens and number-format rules from stage76 remain intact, including malformed-range evidence, one-sided offers, limits and exact amount ceilings.
- Missing currency, unknown period, total/unknown composition, geographic restrictions and multiple different salary variants retain their existing comparison rules.
- Preserve labels, original quotes and source provenance. Each geographic row keeps its own currency/scope; unrelated paragraphs and earlier ranges cannot lend it compensation metadata.
- Text input remains bounded at100,000characters, monetary mentions at100and evidence at the existing limits. Avoid repeated unbounded prefix scans.
- Existing structured provider priority remains intact. No replacement of authoritative board amounts with unrelated prose.

## Amount ownership

Determine the relevant component around each whole monetary mention, considering both its preceding label and directly following component noun. A salary word anywhere earlier in a sentence is insufficient.

- Base salary/pay, total compensation/OTE and existing unknown-composition compensation are distinct owners. A later explicit salary clause can re-establish salary context after a bonus clause.
- A separately stated bonus, equity/stock grant, commission, stipend, allowance, budget or reimbursement amount is not a base-pay range. Support component labels before and directly after the amount, including signing/sign-on and annual bonus modifiers.
- A parenthetical or exclusion such as `Annual base salary (excluding bonus): ...` still labels base salary. Do not reject an entire pay sentence merely because it mentions a bonus.
- A valid base-pay range plus a separate bonus remains eligible for base-pay comparison when the base itself satisfies all existing rules. Do not insert the bonus as an invalid salary range that would disqualify the valid base.
- If an apparent compensation disclosure contains only explicitly rejected component/change amounts, retain the relevant original quote without a base-pay numeric range. Unrelated company financing and other non-compensation numbers remain ignored. Saved correction additionally requires the provenance checks below; any unrelated bonus in a description is not enough to refute an old salary.
- An amount explicitly described as a salary increase/adjustment is not the whole salary. Preserve the quote instead of promoting the increment to base pay.
- Explicit total/OTE pay remains visible as total compensation and is excluded from base comparison.
- Support bounded exclusion relations `excluding`, `excludes`, `exclusive of`, `not including`, `does not include` and `do not include`. A base amount outside the qualifier remains base; a monetary object inside the exclusion, such as `salary excludes a USD 25,000 signing bonus`, belongs to the excluded component.
- Affirmative `includes`, `including` or `inclusive of` relations describing the composition of this same salary amount establish combined `total` compensation. Resolve negation first. A separate total-rewards sentence or possible additional benefit does not relabel an explicitly base-only amount.
- Include explicit commission, RSU/RSUs and stock options as other components. Bare `options` or `grant` alone is not a universal exclusion. `Bonus eligible`, a percentage incentive or `before bonus` does not own the preceding base amount.
- A directly attached salary subject after an amount can establish ownership, as in `USD 120,000–180,000 in annual base salary`.
- Two equally direct incompatible owners of the same amount remain unresolved. `Annual base salary: USD 20,000 signing bonus` retains the numeric disclosure with unknown basis and period. Do not classify a disputed salary as definitely other just to remove it from comparison.
- `Annual salary reviews: <range>` or the corresponding immediate heading establishes an unresolved compensation topic: retain the range with unknown basis and period. A separate explicit base-salary subject remains base even when review prose appears nearby.
- Distinguish the size of a change from the resulting salary. `Annual salary increase: USD 5,000` is a change amount; `Base salary adjusted annually to USD 120,000` states a base amount with unknown period; `Annual base salary adjusted to USD 120,000` preserves an annual base amount.

## Structured other components and the comparison gate

Add the public compensation basis `other` only for positively identified separate non-base structured components. Keep their authoritative numeric bounds, currency, label, scope, evidence and independently stated component unit. Display the suffix ` · 기본급 외 보상`. A signing bonus cannot borrow an annual unit from unrelated base-salary prose.

Text-only rejected amounts use the separate internal findings/evidence path; they do not all become public numeric benefit rows.

Evaluate the existing annual-base comparison gate over actual salary candidates: base, total, unknown and incomplete/unresolvable salary disclosures. Exclude only positively identified `other` components from this candidate set. Keep all existing requirements for the salary candidates: complete valid bounds, one identical variant, base-only composition, known supported currency, annual denomination and no geographic restriction. An empty salary candidate set has `salary:null`. Input limits or unprocessed text that may hide salary still prevent a completeness claim.

| Inputs | Comparison and display |
| --- | --- |
| Valid USD 100,000–120,000 base/year + structured signing bonus USD 25,000 | Compare exactly the base amount; show both rows, bonus as other/unknown-period |
| Same base + explicit other with different currency/period/geographic scope | Same base comparison; the other metadata never changes base metadata |
| Only a structured signing bonus | Show the numeric other row; no annual base salary |
| Valid base + invalid explicitly-other amount | Keep the same base comparison and retain the other quote; no false incomplete-salary warning |
| Invalid/incomplete base + valid other | No base comparison; keep salary evidence and the other row |
| Valid base + total or unknown salary disclosure | Existing conservative exclusion remains |
| Valid base + an ambiguously owned salary/bonus amount | No comparison; unresolved ownership remains an actual salary candidate |

For other-only numeric disclosures use `기본급 외 보상 항목입니다. 기본 연봉 비교에는 사용하지 않습니다.` For a valid base plus an invalid other disclosure, use `기본급 외 보상 일부의 금액을 확인할 수 없어요. 기본 급여와 해당 원문 근거를 함께 표시합니다.` A valid base plus valid other needs no partial/variant warning solely because the other differs. Genuine incomplete salary retains the existing incomplete-salary note.

## Amount unit and shared context

Read a unit from a phrase attached to the salary amount or its applicable pay heading, not from any time word in the same sentence.

- Existing explicit annual/yearly/monthly/weekly/daily/hourly pay labels and `/year`, `/yr`, `/month`, `/mo`, `/week`, `/wk`, `/day`, `/hour`, `/hr`, `/h`, `per year/month/week/day/hour`, `per annum` and `p.a.` forms retain their units.
- A salary review, discussion, adjustment/increase, vesting schedule or other component's cadence cannot supply or contradict the salary unit. Handle modifier-first and verb-first forms, such as `annual salary review` and `salary is reviewed annually`.
- Keep local period resolution per amount. Distinct salary amounts in one line may have different explicit units.
- A genuinely absent local unit may inherit an applicable immediate pay heading or the existing geographic salary section. Conflicting explicit units remain unknown and must not be replaced by a heading fallback.
- Normalize CR, CRLF and LF consistently for context boundaries. Preserve evidence wording apart from the existing normalization performed by provider adapters.
- Amount unit and installment cadence are different facts. Resolve four tiers in order: local amount denomination, applicable heading/context denomination, local payment predicate, applicable context payment predicate. The first tier with signals decides: one unit wins; conflicting units remain unknown without consulting a lower tier. With no signals the period remains unknown.
- Consequently, `Annual base salary ... paid monthly` and `Annual base salary\nUSD 120,000 paid monthly` retain year. `Base salary ... reviewed annually and paid monthly` has month. No numeric multiplication or division occurs.
- Preserve explicit parenthesized pay labels such as `Salary (annual, gross)` and `Base Pay Range (Annual)`. This is an observable grammar requirement, not a mandate to use either a global word bag or one specific regex strategy.
- Other quantities such as `25 days per year` or `40 hours per week` do not establish the salary amount's unit. Preserve the salary's explicit annual/hourly label on the same line.
- Sentence/semicolon ownership boundaries must not depend on capitalization. Protect complete numbers and bounded abbreviations such as `p.a.`, `U.S.`, `U.K.`, `e.g.` and `i.e.` from accidental splitting.
- Stop heading inheritance at intervening unrelated section headings, benefit paragraphs or other-component lines. Evidence must not omit the boundary and present disconnected lines as a continuous source quote.
- Currency resolution uses the same owner's context. In `Annual base salary: $120,000–$180,000 plus a signing bonus of CAD 20,000`, base currency remains unknown. An explicit USD marker on the base range remains USD. Preserve the established same-band geographic reference `(accomplished: ~$145,000 CAD)` as denomination context without treating that reference point as another salary.

## Observable examples

All company names and test postings will be fictional. These examples specify intended user-visible behavior, not expected values computed from product helpers.

| Input | Proposed result |
| --- | --- |
| `Annual base salary is competitive, plus a signing bonus of USD 25,000.` | No annual base salary or base numeric range; original quote visible |
| `Annual base salary: USD 100,000–120,000, plus a signing bonus of USD 25,000.` | Exactly USD100,000–120,000/year base |
| `Annual base salary: USD 100,000–120,000 and a USD 25,000 signing bonus.` | Same one base range; no second base range |
| `A signing bonus of USD 25,000, plus annual base salary USD 100,000–120,000.` | Recover the separately explicit annual base range |
| `Annual base salary (excluding bonus): USD 100,000–120,000.` | Preserve annual base range |
| `Salary: USD 20,000 (signing bonus).` | Explicit bonus owns the amount; no base range |
| `Annual base salary: USD 20,000 signing bonus.` | Conflicting direct owners; numeric unknown-basis/unknown-period disclosure |
| `Base salary: USD 100,000–120,000, reviewed annually.` | Amount preserved, period unknown, excluded from annual comparison |
| `Annual base salary: USD 100,000–120,000, reviewed monthly.` | Preserve year and annual comparison |
| `Base salary: USD 8,000 per month and reviewed annually.` | Preserve month; no annualization |
| `Annual base salary: USD 100,000–120,000 paid monthly.` | Preserve year; monthly describes installments |
| `Monthly base salary: USD 8,000 per year.` | Conflicting explicit amount units remain unknown |
| `Annual salary increase: USD 5,000.` | Preserve quote; do not show USD5,000as the full base salary |
| Greenhouse `Salary Range` + `Base salary is reviewed annually.` | Keep board amounts/currency, period unknown |
| Greenhouse `Annual base salary` + `Base salary is reviewed monthly.` | Keep board amounts/currency and year |

## Stored data and provider behavior

Increment the compensation interpretation version from3to4. The schema accepts unversioned and versions1–4and rejects future/invalid versions. Current fixtures use the version constant; migration fixtures deliberately retain historical versions.

Re-evaluate old text-derived jobs from their own body and separately retained quotes. Keep job/company IDs, descriptions, collection timestamps, saved dates, notes and application status. Do not join independent quotes to lend each other an owner, currency or unit.

An old saved scalar can be positively refuted only using evidence attributable to that old candidate. Prefer its range's own description quote; separately retained evidence requires an unambiguous link to the candidate. Equal numbers alone, another range's quote, or a bonus elsewhere in a truncated body are insufficient. Where an owned quote contains multiple monetary envelopes, ambiguous alignment must not refute a different old salary. The old inferred currency cannot invent a missing association.

If its attributable old candidate is demonstrably other/change, clear the wrong annual-base claim even with `preserveUnverifiable=true`, retaining its correcting quote and the existing no-comparable-range note. A recovered real salary with an unsupported old annual unit keeps its numeric range with corrected/unknown metadata. Neither case uses the unrecoverable-salary exception.

If no salary is recoverable and no attributable candidate is positively refuted, preserve the existing earlier-record treatment for saved scalar amounts, including the older version/label. Discovery/catalog migration excludes that unverifiable scalar from fresh comparison. Do not impose exact old-versus-new numeric equality on ordinary stage76 malformed-number recovery; the new association guard applies to the rejection-only path.

Providers with explicit structured numeric intervals retain those data. Greenhouse amounts differ: period and basis come from title/blurb text. Fresh normalization and old board-range migration must use the corrected context rules, preserve owned numeric bounds/currency/labels/scope/evidence and re-evaluate only the derived period/basis. An explicit other-component title is authoritative for that component and cannot inherit base/year from unrelated blurb prose.

For old Greenhouse ranges, a nonempty owned board quote below the existing 2,000-character limit and a complete attributable label below its 500-character limit permits per-range re-evaluation. At a limit, with missing evidence, or with an incompatible label/quote relation, completeness is unproven. Preserve the numeric disclosure and original evidence and assess period and basis separately:

- Retain an old known attribute only when complete, positively attributable retained wording independently supports that same attribute and no retained wording contradicts it. Otherwise mark that derived attribute unknown.
- Do not promote an old unknown to a salary-qualifying known value from incomplete context. An old unknown period may reflect a real conflict outside the retained prefix.
- A complete attributable title explicitly naming another component may correct basis to `other`; that is a positive non-base owner, not a new annual-salary claim.
- The original title must be identifiable from this board item's evidence, such as an intact label at the start of its owned board quote. A generated `기본 급여`, `게시판의 급여 범위` or numbered display label, the provider name alone, or another item's board marker is not proof of an original title. Missing evidence cannot create provenance.
- For example, a capped quote starting with a complete `Annual base salary` title can retain an old base/year when retained wording contains no conflict. With the same capped quote and old period unknown, keep the period unknown. A complete `Base salary range` title can retain old base but supplies no year. With no attributable title or wording, both derived attributes become unknown.

When an unsupported attribute is demoted, use `이전 게시판 보상의 기간·구성 근거가 충분하지 않아 확인된 금액과 원문만 유지합니다.` as the explanatory note after any more urgent actual incomplete-salary warning. This does not say an otherwise supported base salary was excluded merely because a separate other component has missing metadata. Version 4 means this policy, including explicit unknowns, was applied; it does not certify recovery of missing source facts.

Simply keeping an old version alongside a non-null salary is insufficient for catalog safety: current search/median consumers use `job.salary` regardless of version. A structured numeric row remains visible with unknown derived metadata; it does not need the saved scalar exception.

Mixed records are handled per provenance. Preserve board inputs, correct affected Greenhouse metadata, and independently re-evaluate each description-derived item from its own evidence. One board item cannot exempt or erase other items. If a mixed description-derived numeric disclosure has no recoverable owned evidence, retain its numeric disclosure conservatively with unknown basis/period and an unavailable-evidence explanation; it still blocks a completeness claim. Do not reconstruct mixed historical records by silently deleting all description items as though their unavailable original API response had just been fetched.

For Ashby, Lever, SmartRecruiters and Himalayas board inputs, preserve their structured amount/interval and existing stored metadata; source priority is unchanged. This stage does not re-derive historical Lever text-dependent basis from its combined opaque board quote. Any mixed description items still follow the independent correction rule. Preserve structured incomplete-range evidence and notes; never invent missing bounds.

## Rejection evidence and Himalayas source selection

The internal analysis separates actual salary inputs from explicit other/change findings. Actual salary inputs include base, total, unknown composition, unknown units/currency, and malformed/one-sided salary disclosures. A rejection quote or explanatory note alone is not an actual salary disclosure.

Fresh text with actual salary inputs normalizes those inputs; a separately rejected bonus does not make them incomplete. Rejection-only apparent compensation retains deduplicated original quotes and the existing no-comparable-range note. Keep the internal rejected findings available for provenance-aware saved correction.

Himalayas continues preferring the body when it contains any actual salary disclosure, including malformed salary or a review-labelled unresolved compensation range. If it has none, the existing structured API fallback is eligible even when non-base rejection evidence is retained. API basis stays unknown; no body wording supplements API amount/currency/period. Preserve relevant rejection explanation separately after source selection so it does not change salary completeness or the selected source.

An old normalized body-derived record may never have retained unused API fields. Offline correction cannot recover that discarded fallback. Clear proven wrong salary, preserve available evidence, and record the fresh-versus-migrated difference without inventing API values or refreshing timestamps.

## Verification and phase conditions

Fable independently authors and executes tests. Main implements product code and reviews integration/documentation. Astra independently reviews the contract, code and evidence. All3 approvals bind the same contract, then source/tests/execution plan, then final evidence. No test execution is approved by this draft.

Required final checks: typecheck, full unit suite, build, identical relevant DEV/PROD E2E files with zero retries/skips/flaky passes. Include literal amount/unit/evidence assertions, salary-filter/city-median state transitions, saved correction/reload/export, old catalog upgrade, structured-provider distinctions and 320px layout/accessibility for affected states. Include the new other enum's schema/save/backup/CSV roundtrip and the full base/other/unknown/incomplete comparison matrix. Inspect actual screenshots and preserve failures honestly.

The selected E2E set must contain the stage76 twenty files, the new `compensation-context.spec.ts`, and `qualifications.spec.ts` for its salary/annual-bonus fixture; the latter was not in stage76's twenty-file list. Freeze the actual file paths, commands and required visual cases in the execution plan after test authoring. Do not present that selection as the entire repository E2E suite.

Compare all6,819historical jobs against the captured stage76 state and inspect every semantic change, including gains and losses of comparability and Greenhouse metadata corrections. Compare protected raw Himalayas responses for changes in source priority. Verify original observations/archives unchanged.

After final unanimous approval, commit and push the scoped product/tests/docs. Preserve useful local tools, decisions and results in a local Git archive before deleting all stage-owned reproducible files and processes. Keep irreproducible reference originals and historical observations locally with manifests; preview8787 remains off.

## Discussion resolutions proposed for approval

Main, Astra and Fable independently proposed designs before exchanging them. Fable revised its initial trailing-only and blanket-board-preservation recommendations after the executed counterexamples. Both independent reviewers support explicit `other` representation, local currency ownership, unknown review-labelled ranges and denomination before payment cadence.

This draft chooses per-provenance mixed migration and attribute-wise treatment of incomplete old Greenhouse evidence, retaining independently supported old attributes and marking unsupported ones unknown. Those choices incorporate Astra discussion01 and differ from Fable discussion01's board-only mixed reconstruction and whole-job old-version fallback; the source-consumer reasons are stated above. They are submitted to both reviewers for explicit acceptance or a concrete counterexample. They are not recorded as unanimous merely because other principles were agreed.

The vocabulary is finite and English-focused. This is not a complete natural-language interpretation engine, a fresh crawl or a current-job-validity check. Preserve unsupported cases and established compatible behavior conservatively, and record residual limits. No numeric magnitude/location heuristics, annualization, provider interval reinterpretation, TTL, FX or ranking-policy changes are authorized by this contract.

## References

- [Google JobPosting](https://developers.google.com/search/docs/appearance/structured-data/job-posting): employer-provided actual base salary and explicit unitText values.
- [Schema.org baseSalary](https://schema.org/baseSalary): base salary of the job or employee.
- [ACAS bonuses](https://www.acas.org.uk/bonuses): a bonus is a payment in addition to basic wages; it may be contractual or discretionary.
- [Greenhouse Job Board API](https://docs.greenhouse.io/job-board.html): `pay_input_ranges` supplies cents/currency plus free-form title/blurb, without a numeric interval in the documented example.

The first three references were fetched 2026-09-30 UTC and preserved in ignored `.local/preserved-2026-10-01-stage-77/`. The already-preserved Greenhouse reference was read from `.local/preserved-2026-10-01-stage-76/`. These documents support terminology and data semantics, not a claim of complete natural-language parsing or legal advice.
