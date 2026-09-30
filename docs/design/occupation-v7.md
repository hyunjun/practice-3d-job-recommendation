# Occupation v7 contract — revision 4

This is the common design proposed for stage 71. Approval is recorded separately
against this file's SHA-256. Design approval authorizes implementation; it does
not certify implementation or tests that have not run.

## Problem and evidence

Occupation v6 can mistake an engineering audience for the position being hired,
include physical electronics and supplier-quality positions, and omit computing
positions whose title uses a broader computing term or “Internship”.

The main implementer inspected archived regional inputs without contacting any
posting provider. The frozen baseline contains 6,819 retained jobs across 130
boards (6,700 engineering, 119 research; all occupation v6), and 512 unfiltered
published rows across six regional boards. Normalizing the latter with v6 yields
64 jobs whose IDs exactly match that archived regional snapshot. The retained
v6 upgrade is a no-op; this is a baseline, not an independent correctness test.

A narrow title review identified recruiting, electronics, supplier-quality and
physical failure-analysis candidates, computing positive controls, and a
firmware internship with software implementation duties that v6 excludes.
Original bodies and individual audit records remain local. No population error
rate or present-day posting validity is inferred from these historical inputs.

Occupational context, read on 2026-09-30:

- [Human Resources Specialists, O*NET 13-1071.00](https://www.onetonline.org/link/summary/13-1071.00): recruiting, screening and placement.
- [Electronics Engineers, O*NET 17-2072.00](https://www.onetonline.org/link/summary/17-2072.00): electronic components, circuits and systems.
- [Industrial Engineers, O*NET 17-2112.00](https://www.onetonline.org/link/summary/17-2112.00): production and quality processes.
- [Software Developers, O*NET 15-1252.00](https://www.onetonline.org/link/summary/15-1252.00): software implementation, including collaboration with hardware engineers.

These definitions support the distinction between work and audience; they do
not determine a particular vacancy's occupation without its own evidence.

## Decision rules

1. Advance occupation to version 7; continue accepting historical versions 1–6.
   Recalculate occupation without mutating the input or changing the original
   title, body, ID, URL, source, location, collection time or save metadata.
2. Identify the primary position before interpreting department, product or
   audience qualifiers. Talent acquisition, talent specialists/partners,
   recruiting/candidate-sourcing professionals and people-operations positions
   are other.
   An “Engineering -” prefix cannot override a following HR position. Preserve
   genuine explicit computing co-roles and existing management/support priority.
   For role-neutral heads such as Intern and Working Student, an explicit
   discipline qualifier determines the position using the same HR/physical/
   computing precedence. This does not override a named Assistant, HR or
   physical position.
3. Electronics/electronic-development and supplier-quality positions are
   physical occupations. A software position serving those teams stays
   computing. Do not newly exclude jobs merely because the department is
   “Hardware”, “Hardware Design” or “Supply Chain”.
4. Use consistent explicit computing-position exceptions for physical title
   suffixes and departments. Recognized computing role terms include software,
   firmware, embedded, backend, frontend, full-stack, data, machine learning,
   AI/ML, computer, cybersecurity/security, DevOps/site reliability, cloud,
   mobile/iOS/Android, platform, infrastructure, EDA, RTL, MES, web and network
   when they identify the computing position. Software architect, SDET and
   software development engineer in test are also computing positions.
   Merely mentioning these words as an HR/physical position's audience is
   insufficient. A compound physical position such as Data Center
   Infrastructure Engineer, Computer Hardware Engineer or Embedded Hardware
   Engineer remains physical despite its computing modifier. Preserve the
   existing Offensive Hardware Security Engineer computing exception.
5. Recognize primary software, firmware, embedded-software, backend, frontend,
   full-stack, mobile, iOS, Android, machine-learning, AI and ML internships even
   without “Engineer” or “Developer”. The computing discipline must directly
   qualify Intern/Internship, or appear as the explicit discipline of a
   role-neutral Intern/Working Student head; an intervening Sales or Marketing
   position is insufficient. Explicit Software Engineering Intern and Software
   Development Intern forms are computing. This bounded addition
   does not admit all internships or infer software from student status,
   department, company or optional skills. Other internship title families
   retain their existing interpretation.
6. Failure Analysis Engineer and Failure Analysis Specialist are specifically
   ambiguous families when their primary title does not already establish a
   computing or physical position. The family includes seniority prefixes and
   the EEE specialist form. Its own attributable responsibilities determine:
   - Concrete physical investigation of failed hardware, boards, circuits or
     components: other. This takes precedence when the same role also scripts
     or develops analysis pipelines.
   - Developing/maintaining production software, firmware or software
     crash-analysis systems as the role's own responsibility, with no
     attributable physical failure-investigation duty: engineering.
   - Missing, qualification-only, incidental-tool, optional, introductory,
     other-team-only or negated software evidence: unconfirmed.
   An explicit computing primary position such as Data Engineer - Failure
   Analysis remains engineering. A clearly physical primary position such as
   Electronics Engineer - Failure Analysis remains other.
7. Software evidence for the ambiguous Failure Analysis family must be actual
   duties. Unlike the existing Design Engineer policy, qualifications alone
   cannot establish it. Preserve Design Engineer's existing qualification
   behavior and test this intentional distinction.
8. Ambiguous Failure Analysis positions stay eligible for provider detail
   retrieval. Clear HR/physical positions may be excluded before retrieving
   details. Successful parsing of a valid posting without sufficient occupation
   evidence is distinct from a retrieval failure. A valid bodyless ambiguous
   posting is unconfirmed and excluded, with its ID retained in the successful
   inventory. A required detail request, response-schema or identity failure
   fails the board's content attempt; it must not become a successful partial
   snapshot. Preserve the prior snapshot and its source clocks, record the new
   attempt's error/backoff state, and invent no snapshot if none existed.
9. Fresh normalization, cache reads, Worker/browser upgrades and saved-record
   upgrades apply the same occupation rules and agree on category and
   exploration eligibility for equivalent available title, description,
   department, management and preserved occupation evidence. Historical
   reclassification uses the stored description and available historical
   evidence; it cannot reconstruct discarded text. Preserve the original stored
   body and metadata, and record unavailable evidence as a limitation. Saved
   jobs excluded from exploration stay readable, editable and exportable. A
   still-published excluded job remains listed.
10. Occupation v7 changes the observation method. Preserve original v6 snapshot
    methods and historical aggregates. A reinterpretation of a cached snapshot
    is not a market decline or a new comparable collection. Only sufficient,
    complete observations under the same current method may produce a delta.

## Literal classification matrix

Test bodies must be fictional. Expected categories, inclusion, labels, titles,
counts and prior v6 assessments must be literal. Creating input with a product
helper is not itself a derived oracle, but historical fixtures must explicitly
encode the old assessment. Do not replace literal assertions with equality to
the current classifier, upgrader or label function.

### Primary positions and physical roles

| Title and evidence | Category |
| --- | --- |
| Senior Talent Specialist - Product and Engineering; recruiting duties | other |
| Talent Partner, Engineering; recruiting duties | other |
| Senior Technical Sourcer, Applications Engineering | other |
| People Operations, Engineering | other |
| Engineering - Talent Acquisition Specialist | other |
| Talent Internship for Software Engineering; recruiting duties | other |
| Lead Supplier Quality Engineer; supplied-component inspection | other |
| Principal Supplier Quality Engineer; supplied-component inspection | other |
| Engineer, Supplier Quality; supplied-component inspection | other |
| Experienced Electronics Engineer; circuit design | other |
| Lead Electronic Development Engineer; circuit design | other |
| Electronics Engineer - Failure Analysis; failed-board investigation | other |
| Hardware Test Engineer | other |
| Hardware Internship | other |
| Data Center Engineer | other |
| Data Center Infrastructure Engineer | other |
| Datacenter Operations Engineer | other |
| Computer Hardware Engineer | other |
| Embedded Hardware Engineer | other |
| Engineering - Backend Developer | engineering |
| Software Engineer - Talent Platform | engineering |
| Talent Platform Engineer; exposed role [devops] | engineering |
| Recruiting Analytics Data Engineer; exposed role [data] | engineering |
| Software Engineer, Applied Emerging Talent (2027) | engineering |
| Backend Engineer, Electronics Store | engineering |
| Electronic Trading Developer | engineering |
| Software Engineer, Network Automation - Data Center Fabrics | engineering |
| Staff Engineer, Datacenter Server Lifecycle | engineering |
| Offensive Hardware Security Engineer | engineering |
| Data Engineer, Supply Chain Analytics | engineering |
| Machine Learning Engineer, Failure Prediction | engineering |
| AI Research Scientist - Electronics Design; own AI research duties | research |
| UX Researcher for Engineering; user-interview duties | other |
| Executive Assistant, Software Engineering | other |
| Sourcing Engineer; inherited generic-engineer policy | engineering |
| Tech Lead - Software Engineering; no management/support override; exposed roles [] | engineering |
| Team Lead, Backend Engineering; no management/support override; exposed role [backend] | engineering |

### Internships and neutral heads

| Title | Category | Literal exposed role(s) |
| --- | --- | --- |
| Software Internship | engineering | [] |
| Firmware Intern | engineering | [] |
| Firmware Internship 2026/2027 | engineering | [] |
| Embedded Software Internship | engineering | [] |
| Backend Internship | engineering | [backend] |
| Frontend Internship | engineering | [frontend] |
| Full Stack Intern | engineering | [fullstack] |
| Mobile Intern | engineering | [mobile] |
| iOS Intern | engineering | [mobile] |
| Android Internship | engineering | [mobile] |
| Machine Learning Intern | engineering | [ml] |
| AI Internship | engineering | [ml] |
| ML Intern | engineering | [ml] |
| Software Engineering Intern | engineering | [] |
| Software Development Intern | engineering | [] |
| Intern, Software Engineering | engineering | [] |
| Working Student - Software Engineering | engineering | [] |
| Intern - Firmware | engineering | [] |
| Intern, Talent Acquisition | other | [] |
| Intern, Hardware | other | [] |
| Software Sales Internship | unconfirmed | [] |
| Software Marketing Intern | unconfirmed | [] |

The computing internship rows are eligible with empty or attributable
software-duty bodies. A literal `[]` specialty means `role: unknown`, not an
invented backend or other specialty.

### Computing controls

Each title in this table must be engineering in **both** forms: the unmodified
title in a Hardware department and the title followed by ` - Hardware`.
Department labels cannot manufacture a role specialty.

| Title | Literal exposed role(s) |
| --- | --- |
| Senior Software Engineer | [] |
| Senior Firmware Engineer | [] |
| Embedded Software Engineer | [] |
| Backend Engineer | [backend] |
| Frontend Engineer | [frontend] |
| Full Stack Engineer | [fullstack] |
| Cloud Engineer | [devops] |
| Mobile Engineer | [mobile] |
| Senior iOS Engineer | [mobile] |
| Android Engineer | [mobile] |
| Platform Engineer | [devops] |
| Infrastructure Engineer | [devops] |
| Software Infrastructure Engineer | [devops] |
| EDA Engineer | [] |
| RTL Design Engineer | [] |
| MES Engineer | [] |
| Network Engineer | [] |
| Software QA Engineer | [] |
| Software Test Automation Engineer | [] |
| SDET | [] |
| Software Development Engineer in Test | [] |

Additional engineering controls:

- Senior Software Engineer - Production Test Systems, in Hardware/Production.
- Senior Firmware Engineer, in Hardware/Hardware Platform.
- Engineer, Marketing Engineer and Developer Relations Engineer in Marketing.
- Systems Engineer, Test Engineer, Quality Engineer and Test Automation Engineer
  in Hardware with empty bodies.
- Bare Engineering, preserving the existing broad title policy.

Generic `Test Automation Engineer - Hardware` remains other without an explicit
computing primary title. The corresponding department-only title remains
engineering under the inherited generic-engineer policy. Generic QA/automation
is not newly declared computing; Software QA and SDET are explicit controls.

### Ambiguous Failure Analysis

Use both Engineer and Specialist forms, including EEE Failure Analysis Specialist
(Satellite PCB Engineering). A Hardware department alone is insufficient.

| Attributable evidence | Category |
| --- | --- |
| Responsibilities: inspect failed boards, cross-section solder joints and identify failed components | other |
| Same physical duties plus writing Python analysis pipelines | other |
| Responsibilities: develop production crash-analysis software and maintain its application code and automated tests | engineering |
| Responsibilities: design and implement firmware features and maintain firmware tests | engineering |
| Empty body | unconfirmed |
| Qualifications: experience developing production software | unconfirmed |
| Preferred: experience developing production software | unconfirmed |
| Responsibilities: use Python and SQL to summarize measurements | unconfirmed |
| About us: our company develops AI software | unconfirmed |
| Responsibilities: the software team develops production software; this role provides their measurements | unconfirmed |
| Responsibilities: this role does not develop or maintain software | unconfirmed |
| Key accountabilities: develop production software (no recognized role heading or direct “you will” sentence) | unconfirmed |

For comparison, Design Engineer with `You have` / experience building frontend
applications remains engineering. Record the intentionally different standard.

The physical-first rule conservatively excludes a genuine mixed physical and
software Failure Analysis role unless its primary title explicitly establishes
computing. Heading recognition remains bounded; unrecognized headings can leave
an otherwise eligible ambiguous role unconfirmed. These are visible limitations,
not claims that those positions can never involve software.

## Provider, persistence and history contracts

- `needsOccupationDescription` is true for an unresolved Failure Analysis
  Engineer or Specialist with an empty body, and for a computing internship.
  It is false for Senior Talent Specialist - Product and Engineering.
- A list-only provider must fetch an ambiguous role's detail and include it
  when the detail establishes the computing duty. Exercise a nontrivial
  provider page with both included and excluded roles.
- A Greenhouse row with an ambiguous title and no content is unconfirmed and
  excluded; its published ID is retained. Ashby department/team shapes also
  exercise the primary-role cases.
- A required detail request, response-schema or identity failure fails the
  board's content collection attempt; it must not become an excluded row inside
  a successful partial snapshot. Preserve any prior snapshot, including its
  jobs, published IDs, totals, unmapped count, observation method and successful
  fetch time. Record the new attempt's checkedAt, error and failure/backoff
  state. Without a prior snapshot, do not invent one. The failed attempt must
  not create a new complete observation or imply a saved job has closed.
  Test both a valid bodyless posting with successful inventory and a required
  detail failure with prior snapshot preservation, plus failure without a prior
  snapshot.
- Literal v6 records for newly excluded positions upgrade to v7. The original
  object remains unchanged; a second upgrade is idempotent. Historical
  description evidence beyond the stored body remains available.
- Pin the evidence boundary: a v6 Failure Analysis Engineer in Hardware without
  preserved attributable duties becomes v7 unconfirmed. Fresh input for that
  posting with its own physical-investigation duties is other. When those
  duties survive in historical description evidence beyond the stored body,
  migration also yields other. Source normalization stores at most 26,000 body
  characters; parity does not manufacture discarded text.
- Cache envelope version 5 still accepts occupation v6 records. Only retained
  jobs/included counts and excluded unmapped counts change. IDs, totals,
  checkedAt, source URLs and old observation methods remain unchanged.
- Saved v6 physical jobs retain note, application status and savedAt across
  browser reload, editing and JSON backup/import. CSV displays the literal
  `기타 직군` label. A published ID excluded from exploration remains listed,
  with the existing notice that the position is outside exploration scope.
  Also verify a saved v6 ambiguous Failure Analysis record that becomes
  unconfirmed: it stays saved and displays the literal
  `개발·컴퓨터 연구 여부 미확인` label, at least at unit level.
- Worker/browser catalog presentation and progress do not reintroduce excluded
  jobs or erase filters, selected jobs or save state during refresh.
- Comparability depends on the full observation-method markers, cohort and
  completeness, rather than cache origin alone. Complete cached snapshots whose
  markers all match the current method remain comparable at their original
  observation dates. Missing, old or mixed method markers yield
  `comparable: false` under the current method even after their jobs become v7.
  Cache reads must not rewrite original markers or historical aggregates,
  renew source clocks, or invent another collection day. Preserve old series
  and failed/partial-refresh behavior; require sufficient complete, compatible
  observations on distinct dates before showing a delta. Reclassifying six v6
  jobs as two v7 jobs is not a market decline.
  Literal controls: matching-current-method complete cache is
  `comparable: true`; old/missing/mixed markers are false; rereading an existing
  observation adds no collection day. Existing freshness checks still apply.

### Version literals

Schema and types accept versions 1–7 and reject 0 and 8. Keep literal version 6
in the historical union; changing only the current constant would discard it.

- Current occupation assertions in occupation-title-scope, finance, careers
  industry, regional cache/read/observation tests move intentionally to 7.
- `REGIONAL_CURRENT_METHOD` and current-method expectations use
  `observations-2.cities-1.occupation-7.roles-1.qualifications-1.remote-3.employment-1.purpose-1`.
- `REGIONAL_LEGACY_METHOD`, default-public's `observations-1` data, and historical
  observation fixtures in catalog-presentation, source-integrations-lifecycle,
  regional-read-upgrade and regional-persistence retain their old values.
- lever-pagination and bulk-inventory E2E snapshots that assert the current
  method move to occupation 7. Existing historical method fixtures stay old.
- Review each remaining current-version pin by its meaning. Do not perform a
  global replacement of 6 with 7 or relabel old assessments as new inputs.

## Independent verification plan

Fable owns test changes and execution; main owns product implementation and
integration; Astra independently reviews the final product and test changes.
All participants receive failures, fixes and the same identified final state.

1. Unit tests use the literal matrix, existing research/management/support/
   design controls, fresh normalizers, provider detail selection and errors,
   legacy upgrades, source nonmutation, saved backup/status and observations.
2. Stateful E2E use a small fictional catalog with literal accepted titles and
   counts. Include HR and physical exclusions, two hardware-team computing
   controls, a firmware internship, Talent Tools software, Failure Prediction
   ML, mobile and cloud roles. Search Talent/Failure, select mobile, save,
   refresh with same-ID reclassification and a new computing job, then reload.
   Assert visible titles, totals, filter/query continuity and saved state at
   desktop (1440) and narrow mobile (320), with accessibility checks.
3. A separate saved-v6 flow verifies the out-of-scope notice, literal label,
   application status, note editing, listed status, JSON/CSV export and
   backup/import. It must not compute expected values using product upgrades.
4. Main reruns the frozen audit over all 6,819 retained jobs and 512 unfiltered
   regional rows with networking disabled. Compare v6/v7 categories and
   included IDs, inspect every changed case and the named positive controls,
   check input digests and original-field preservation, and report counts and
   limits. This audit is not a population false-negative estimate.
5. On the final implementation/test state, run type checks, the full unit suite,
   the production build and the full E2E suite in development **and**
   production modes. Synthetic servers only; no user preview server or posting
   collection. Failed or interrupted runs are reported with targeted reruns
   and do not become an invented full clean run.
6. Record explicit unanimous implementation-review and verification-complete
   approvals against the reviewed source/test state. A design approval does
   not stand in for either. Preserve conclusions, changes and results in Git.
7. Stop owned test servers/browsers/agents and delete this stage's temporary
   data copies, logs, reference HTML, model transcripts, scripts, builds,
   caches, screenshots, traces and worktrees after preserving useful results.
   Protect the historical archive and observation records specified by the
   repository's retention policy; verify remaining files and processes.

## Accepted scope boundaries to confirm at the design gate

Generic-engineer (including Sourcing Engineer) and bare-Engineering ambiguity,
generic automation asymmetry, bounded heading/primary-internship recognition,
the conservative mixed-role rule and existing Design Engineer qualification
behavior are explicit here. This stage does not claim to fix every occupation
ambiguity, management typo, all internship disciplines or every publisher's
prose format.

New evidence of a required defect is shared with all participants. An objection
cannot be silently relabelled a limitation to obtain agreement. Any required
contract revision receives a new hash and renewed unanimous design approval.
